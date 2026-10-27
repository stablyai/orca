// Reposting accumulated replies per delta causes quadratic traffic and freezes the UI.
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

    // OpenCode streams full accumulated text in each part update.
    let text = ''
    for (let i = 0; i < 50; i++) {
      text += 'chunk-of-streamed-reply-text-'.repeat(10)
      await handler(assistantPartEvent(text))
    }

    expect(messagePartPosts()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(300)

    const parts = messagePartPosts()
    expect(parts).toHaveLength(2)
    const trailing = parts[1].body.payload
    expect(trailing.text!.length).toBeLessThanOrEqual(4000)
    expect(text.startsWith(trailing.text!)).toBe(true)
  })

  it('flushes the pending reply snapshot before posting SessionIdle', async () => {
    const handler = await loadPluginEventHandler()
    await seedAssistantRole(handler)
    // Seed busy so the idle transition is not deduplicated.
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

  it('waits for an in-flight preview before delivering SessionIdle', async () => {
    let releasePart: (() => void) | undefined
    const delayedPart = new Promise<void>((resolve) => {
      releasePart = resolve
    })
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const post = { url: String(url), body: JSON.parse(String(init?.body)) } as RecordedPost
      posts.push(post)
      if (post.body.payload.hook_event_name === 'MessagePart') {
        await delayedPart
      }
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const handler = await loadPluginEventHandler()
    await seedAssistantRole(handler)
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'busy' } }
      }
    })
    posts.length = 0

    await handler(assistantPartEvent('completed reply'))
    const idle = handler({
      event: { type: 'session.idle', properties: { sessionID: 'session-1' } }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(posts.map((post) => post.body.payload.hook_event_name)).toEqual(['MessagePart'])

    releasePart?.()
    await idle
    expect(posts.map((post) => post.body.payload.hook_event_name)).toEqual([
      'MessagePart',
      'SessionIdle'
    ])
  })

  it('clears question attention when its tool part completes without a reply event', async () => {
    const handler = await loadPluginEventHandler()
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'busy' } }
      }
    })
    await handler({
      event: {
        type: 'question.asked',
        properties: {
          id: 'question-1',
          sessionID: 'session-1',
          tool: { messageID: 'message-1', callID: 'call-1' }
        }
      }
    })
    expect(posts.at(-1)?.body.payload.hook_event_name).toBe('AskUserQuestion')

    await handler({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: {
            type: 'tool',
            tool: 'question',
            messageID: 'message-1',
            callID: 'call-1',
            state: { status: 'completed' }
          }
        }
      }
    })
    expect(posts.at(-1)?.body.payload.hook_event_name).toBe('SessionBusy')
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

    await seedAssistantRole(handler)
    await handler(assistantPartEvent('assistant reply'))
    expect(messagePartPosts()).toHaveLength(2)
  })
})
