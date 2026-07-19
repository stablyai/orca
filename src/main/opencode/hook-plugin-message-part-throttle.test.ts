/**
 * Executes the generated OpenCode plugin source (the artifact that runs inside
 * OpenCode's process) to verify current message.part.delta streams and older
 * full message.part.updated snapshots are coalesced and capped before POSTing
 * to Orca's agent-hook server. Token-cadence posts saturated Orca's main +
 * renderer event loops on Windows and froze the UI mid-reply.
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
          part: { id: 'part-assistant', type: 'text', text, messageID: 'msg-assistant' }
        }
      }
    }
  }

  function assistantDeltaEvent(delta: string): { event: unknown } {
    return {
      event: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-1',
          messageID: 'msg-assistant',
          partID: 'part-assistant',
          field: 'text',
          delta
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

  it('accumulates current delta streams into leading + trailing capped previews', async () => {
    const handler = await loadPluginEventHandler()
    await seedAssistantRole(handler)
    await handler(assistantPartEvent(''))

    // Current OpenCode sends an empty text-start part followed by deltas.
    let text = ''
    for (let i = 0; i < 50; i++) {
      const delta = 'chunk-of-streamed-reply-text-'.repeat(10)
      text += delta
      await handler(assistantDeltaEvent(delta))
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

  it('keeps compatibility with older repeated full-part snapshots', async () => {
    const handler = await loadPluginEventHandler()
    await seedAssistantRole(handler)

    await handler(assistantPartEvent('first'))
    await handler(assistantPartEvent('first second'))
    await vi.advanceTimersByTimeAsync(300)

    expect(messagePartPosts().map((post) => post.body.payload.text)).toEqual([
      'first',
      'first second'
    ])
  })

  it('keeps failed delta delivery inside the throttle instead of retrying every event', async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(null, { status: 503 })
    }) as typeof globalThis.fetch
    const handler = await loadPluginEventHandler()
    await seedAssistantRole(handler)

    for (let index = 0; index < 50; index++) {
      await handler(assistantDeltaEvent(`chunk-${index}`))
    }

    // A stale token or restarting hook server must not turn each OpenCode
    // token into its own failed request and block the shared event queue.
    expect(messagePartPosts()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(250)
    expect(messagePartPosts()).toHaveLength(2)
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

    await handler(assistantPartEvent(''))
    await handler(assistantDeltaEvent('first'))
    await handler(assistantDeltaEvent(' final'))
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
