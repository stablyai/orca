/**
 * Executes the generated OpenCode plugin source (the artifact that runs inside
 * OpenCode's process) to verify streamed message.part.updated events are
 * coalesced and capped before POSTing to Orca's agent-hook server. The
 * un-throttled plugin re-posted the full accumulated reply per streamed
 * append — O(n²) bytes per turn — which saturated Orca's main + renderer
 * event loops on Windows and froze the UI mid-reply.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { _internals } from './hook-service'

type RecordedPost = {
  url: string
  body: {
    paneKey: string
    payload: { hook_event_name: string; role?: string; text?: string }
  }
}

type PluginEventHandler = (input: { event: unknown }) => Promise<void>

const ENV_KEYS = ['ORCA_PANE_KEY', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN'] as const

describe('OpenCode plugin MessagePart throttling', () => {
  let tempDir: string
  let posts: RecordedPost[]
  let savedEnv: Record<string, string | undefined>
  let savedFetch: typeof globalThis.fetch

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-plugin-test-'))
    posts = []
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    process.env.ORCA_AGENT_HOOK_PORT = '45678'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    savedFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = savedFetch
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function loadPluginEventHandler(): Promise<PluginEventHandler> {
    const pluginPath = join(tempDir, 'orca-opencode-status.mjs')
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      OrcaOpenCodeStatusPlugin: (ctx: unknown) => Promise<{ event: PluginEventHandler }>
    }
    const client = {
      session: {
        // No parentID → root session, events flow through.
        list: async () => ({ data: [{ id: 'session-1' }] })
      }
    }
    const hooks = await module.OrcaOpenCodeStatusPlugin({ client })
    return hooks.event
  }

  function assistantPartEvent(text: string): { event: unknown } {
    return {
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: { type: 'text', text, messageID: 'msg-assistant' }
        }
      }
    }
  }

  async function seedAssistantRole(handler: PluginEventHandler): Promise<void> {
    await handler({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-1',
          info: { id: 'msg-assistant', role: 'assistant' }
        }
      }
    })
  }

  function messagePartPosts(): RecordedPost[] {
    return posts.filter((post) => post.body.payload.hook_event_name === 'MessagePart')
  }

  it('coalesces a streamed reply into leading + trailing posts with capped text', async () => {
    const handler = await loadPluginEventHandler()
    await seedAssistantRole(handler)

    // Simulate a streaming turn: 50 part updates, each carrying the full
    // accumulated text so far (how OpenCode actually publishes parts).
    let text = ''
    for (let i = 0; i < 50; i++) {
      text += 'chunk-of-streamed-reply-text-'.repeat(10)
      await handler(assistantPartEvent(text))
    }

    // Leading edge only — everything else is pending behind the throttle.
    expect(messagePartPosts()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(300)

    const parts = messagePartPosts()
    expect(parts).toHaveLength(2)
    // Trailing post carries the LATEST snapshot, capped.
    const trailing = parts[1].body.payload
    expect(trailing.text!.length).toBeLessThanOrEqual(4000)
    expect(text.startsWith(trailing.text!)).toBe(true)
  })

  it('flushes the pending reply snapshot before posting SessionIdle', async () => {
    const handler = await loadPluginEventHandler()
    await seedAssistantRole(handler)
    // Mark the session busy so the idle transition is not deduped away.
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'busy' } }
      }
    })
    posts.length = 0

    await handler(assistantPartEvent('first'))
    await handler(assistantPartEvent('first final'))
    expect(messagePartPosts()).toHaveLength(1)

    await handler({
      event: { type: 'session.idle', properties: { sessionID: 'session-1' } }
    })

    const eventNames = posts.map((post) => post.body.payload.hook_event_name)
    expect(eventNames).toEqual(['MessagePart', 'MessagePart', 'SessionIdle'])
    expect(posts[1].body.payload.text).toBe('first final')
  })

  it('posts user prompts immediately without consuming the assistant throttle slot', async () => {
    const handler = await loadPluginEventHandler()
    await handler({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-1',
          info: { id: 'msg-user', role: 'user' }
        }
      }
    })

    await handler({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: { type: 'text', text: 'u'.repeat(10_000), messageID: 'msg-user' }
        }
      }
    })

    const parts = messagePartPosts()
    expect(parts).toHaveLength(1)
    expect(parts[0].body.payload.role).toBe('user')
    expect(parts[0].body.payload.text!.length).toBe(4000)

    // An assistant part right after the user prompt still posts immediately
    // (leading edge) because user posts do not touch the throttle clock.
    await seedAssistantRole(handler)
    await handler(assistantPartEvent('assistant reply'))
    expect(messagePartPosts()).toHaveLength(2)
  })
})
