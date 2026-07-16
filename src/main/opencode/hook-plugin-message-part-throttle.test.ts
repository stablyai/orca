/**
 * Executes the generated OpenCode plugin source (the artifact that runs inside
 * OpenCode's process) to verify both streamed message throttling and child
 * session lifecycle before POSTing to Orca's agent-hook server. Running the
 * emitted artifact catches ordering and state bugs that source-string checks
 * cannot, while retaining the original O(n²) streaming regression coverage.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
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
    payload: {
      hook_event_name: string
      role?: string
      text?: string
      sessionID?: string
      agent_id?: string
      agent_type?: string
      description?: string
    }
  }
}

type PluginEventHandler = (input: { event: unknown }) => Promise<void>

const ENV_KEYS = ['ORCA_PANE_KEY', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN'] as const

describe('OpenCode generated plugin runtime', () => {
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

  async function loadPluginEventHandler(
    listSessions: () => Promise<{ data: Record<string, unknown>[] }> = async () => ({
      data: [{ id: 'session-1' }]
    })
  ): Promise<PluginEventHandler> {
    const pluginPath = join(tempDir, 'orca-opencode-status.mjs')
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      OrcaOpenCodeStatusPlugin: (ctx: unknown) => Promise<{ event: PluginEventHandler }>
    }
    const client = {
      session: {
        list: listSessions
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

  function lifecyclePosts(): RecordedPost[] {
    return posts.filter((post) =>
      ['SubagentStart', 'SubagentStop'].includes(post.body.payload.hook_event_name)
    )
  }

  function expectedAgentId(rawIdentity: string): string {
    const digest = createHash('sha256')
      .update(`opencode\0${rawIdentity}`)
      .digest('hex')
      .slice(0, 32)
    return `opencode-${digest}`
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

  it('keeps the root lifecycle independent while a background child remains active', async () => {
    const handler = await loadPluginEventHandler()

    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'busy' } }
      }
    })
    await handler({
      event: {
        type: 'session.created',
        properties: {
          info: {
            id: 'child-background-1',
            parentID: 'session-1',
            agent: 'reviewer',
            title: 'Review background change'
          }
        }
      }
    })
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-background-1', status: { type: 'busy' } }
      }
    })
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'idle' } }
      }
    })
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-background-1', status: { type: 'idle' } }
      }
    })
    // OpenCode emits both status-idle and session.idle for the same transition.
    await handler({
      event: { type: 'session.idle', properties: { sessionID: 'child-background-1' } }
    })

    expect(posts.map((post) => post.body.payload.hook_event_name)).toEqual([
      'SessionBusy',
      'SubagentStart',
      'SessionIdle',
      'SubagentStop'
    ])
    expect(lifecyclePosts().map((post) => post.body.payload)).toEqual([
      {
        hook_event_name: 'SubagentStart',
        agent_id: expectedAgentId('child-background-1'),
        agent_type: 'reviewer',
        description: 'Review background change'
      },
      {
        hook_event_name: 'SubagentStop',
        agent_id: expectedAgentId('child-background-1'),
        agent_type: 'reviewer',
        description: 'Review background change'
      }
    ])
    expect(JSON.stringify(lifecyclePosts())).not.toContain('child-background-1')
  })

  it('retries a network-failed child start on later activity and dedupes after success', async () => {
    const handler = await loadPluginEventHandler()
    await handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-retry', parentID: 'session-1' } }
      }
    })
    const attempts: RecordedPost[] = []
    let shouldFail = true
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      attempts.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      if (shouldFail) {
        shouldFail = false
        throw new Error('stale endpoint')
      }
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const busy = {
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-retry', status: { type: 'busy' } }
      }
    }

    await handler(busy)
    await handler(busy)
    await handler(busy)

    expect(attempts.map((attempt) => attempt.body.payload.hook_event_name)).toEqual([
      'SubagentStart',
      'SubagentStart'
    ])
  })

  it('bounds a stalled child start and retries it after the timeout', async () => {
    const handler = await loadPluginEventHandler()
    await handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-timeout', parentID: 'session-1' } }
      }
    })
    const signals: AbortSignal[] = []
    let attempt = 0
    globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      attempt += 1
      if (init?.signal) {
        signals.push(init.signal)
      }
      return attempt === 1
        ? new Promise<Response>(() => {})
        : Promise.resolve(new Response(null, { status: 204 }))
    }) as typeof globalThis.fetch
    const busy = {
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-timeout', status: { type: 'busy' } }
      }
    }

    const timedOut = handler(busy)
    const coalesced = handler(busy)
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve()
    }
    expect(attempt).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all([timedOut, coalesced])
    expect(signals[0]?.aborted).toBe(true)

    await handler(busy)
    expect(attempt).toBe(2)
  })

  it('retries root status after non-2xx and re-announces it to a new endpoint generation', async () => {
    const handler = await loadPluginEventHandler()
    const attempts: { url: string; token: string }[] = []
    let attempt = 0
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      attempt += 1
      const headers = init?.headers as Record<string, string>
      attempts.push({
        url: String(url),
        token: headers['X-Orca-Agent-Hook-Token']
      })
      return new Response(null, { status: attempt === 1 ? 503 : 204 })
    }) as typeof globalThis.fetch
    const busy = {
      event: {
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'busy' } }
      }
    }

    await handler(busy)
    await handler(busy)
    await handler(busy)
    expect(attempts).toHaveLength(2)

    process.env.ORCA_AGENT_HOOK_PORT = '45680'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'replacement-token'
    await handler(busy)
    await handler(busy)

    expect(attempts).toEqual([
      { url: 'http://127.0.0.1:45678/hook/opencode', token: 'test-token' },
      { url: 'http://127.0.0.1:45678/hook/opencode', token: 'test-token' },
      { url: 'http://127.0.0.1:45680/hook/opencode', token: 'replacement-token' }
    ])
  })

  it('delivers a concurrent stop only after a slow lifecycle start completes', async () => {
    const handler = await loadPluginEventHandler()
    await handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-overlap', parentID: 'session-1' } }
      }
    })

    const delivered: string[] = []
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RecordedPost['body']
      const eventName = body.payload.hook_event_name
      if (eventName === 'SubagentStart') {
        await startGate
      }
      delivered.push(eventName)
      return new Response(null, { status: 204 })
    })
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const start = handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-overlap', status: { type: 'busy' } }
      }
    })
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve()
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const stop = handler({
      event: { type: 'session.idle', properties: { sessionID: 'child-overlap' } }
    })
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve()
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)

    releaseStart()
    await Promise.all([start, stop])
    expect(delivered).toEqual(['SubagentStart', 'SubagentStop'])
  })

  it('shares an in-flight lineage lookup so a later idle cannot resolve before busy', async () => {
    let resolveList!: (value: { data: Record<string, unknown>[] }) => void
    const listResult = new Promise<{ data: Record<string, unknown>[] }>((resolve) => {
      resolveList = resolve
    })
    const listSessions = vi.fn(() => listResult)
    const handler = await loadPluginEventHandler(listSessions)

    const busy = handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-lineage-race', status: { type: 'busy' } }
      }
    })
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve()
    }
    expect(listSessions).toHaveBeenCalledTimes(1)

    const idle = handler({
      event: { type: 'session.idle', properties: { sessionID: 'child-lineage-race' } }
    })
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve()
    }
    expect(listSessions).toHaveBeenCalledTimes(1)

    resolveList({
      data: [{ id: 'session-1' }, { id: 'child-lineage-race', parentID: 'session-1' }]
    })
    await Promise.all([busy, idle])

    expect(lifecyclePosts().map((post) => post.body.payload.hook_event_name)).toEqual([
      'SubagentStart',
      'SubagentStop'
    ])
  })

  it('does not resurrect a deleted child when an earlier lineage lookup resolves late', async () => {
    let resolveList!: (value: { data: Record<string, unknown>[] }) => void
    const listResult = new Promise<{ data: Record<string, unknown>[] }>((resolve) => {
      resolveList = resolve
    })
    const handler = await loadPluginEventHandler(() => listResult)

    const busy = handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-delete-race', status: { type: 'busy' } }
      }
    })
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve()
    }
    await handler({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'child-delete-race', parentID: 'session-1' } }
      }
    })
    resolveList({
      data: [{ id: 'session-1' }, { id: 'child-delete-race', parentID: 'session-1' }]
    })
    await busy

    expect(lifecyclePosts()).toHaveLength(0)
  })

  it('tracks concurrent direct and nested children by distinct hashed identities', async () => {
    const handler = await loadPluginEventHandler()

    for (const info of [
      { id: 'child-direct', parentID: 'session-1', agent: 'explore' },
      { id: 'child-nested', parentID: 'child-direct', agent: 'review' }
    ]) {
      await handler({ event: { type: 'session.created', properties: { info } } })
    }
    for (const sessionID of ['child-direct', 'child-nested']) {
      await handler({
        event: {
          type: 'session.status',
          properties: { sessionID, status: { type: 'busy' } }
        }
      })
    }
    // Repeated busy/retry events do not create duplicate roster entries.
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-direct', status: { type: 'retry' } }
      }
    })

    expect(
      lifecyclePosts()
        .filter((post) => post.body.payload.hook_event_name === 'SubagentStart')
        .map((post) => post.body.payload.agent_id)
    ).toEqual([expectedAgentId('child-direct'), expectedAgentId('child-nested')])

    for (const sessionID of ['child-nested', 'child-direct']) {
      await handler({
        event: { type: 'session.idle', properties: { sessionID } }
      })
    }
    expect(
      lifecyclePosts()
        .filter((post) => post.body.payload.hook_event_name === 'SubagentStop')
        .map((post) => post.body.payload.agent_id)
    ).toEqual([expectedAgentId('child-nested'), expectedAgentId('child-direct')])
  })

  it('does not gate a created-only child and drains an active child on delete', async () => {
    const handler = await loadPluginEventHandler()

    await handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-never-busy', parentID: 'session-1' } }
      }
    })
    await handler({
      event: { type: 'session.idle', properties: { sessionID: 'child-never-busy' } }
    })
    await handler({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'child-never-busy', parentID: 'session-1' } }
      }
    })
    expect(lifecyclePosts()).toHaveLength(0)

    await handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-deleted', parentID: 'session-1' } }
      }
    })
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-deleted', status: { type: 'busy' } }
      }
    })
    // Error is not authoritative completion; delete is.
    await handler({
      event: { type: 'session.error', properties: { sessionID: 'child-deleted' } }
    })
    await handler({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'child-deleted', parentID: 'session-1' } }
      }
    })
    await handler({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'child-deleted', parentID: 'session-1' } }
      }
    })

    expect(lifecyclePosts().map((post) => post.body.payload.hook_event_name)).toEqual([
      'SubagentStart',
      'SubagentStop'
    ])
  })

  it('fails closed on unknown lineage and ignores malformed child events', async () => {
    const handler = await loadPluginEventHandler(async () => {
      throw new Error('session list unavailable')
    })

    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'unknown-session', status: { type: 'busy' } }
      }
    })
    await handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'x'.repeat(1025), parentID: 'root' } }
      }
    })
    await handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'valid-child', parentID: 'root' } }
      }
    })
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'valid-child', status: { type: 'not-a-status' } }
      }
    })
    await handler({ event: { type: 'session.created', properties: { info: null } } })
    await handler({ event: null })

    expect(posts).toHaveLength(0)
  })

  it('re-emits an overflow child after a visible roster slot becomes available', async () => {
    const handler = await loadPluginEventHandler()

    for (let index = 0; index < 33; index += 1) {
      const sessionID = `child-cap-${index}`
      await handler({
        event: {
          type: 'session.created',
          properties: { info: { id: sessionID, parentID: 'session-1' } }
        }
      })
      await handler({
        event: {
          type: 'session.status',
          properties: { sessionID, status: { type: 'busy' } }
        }
      })
    }

    expect(
      lifecyclePosts().filter((post) => post.body.payload.hook_event_name === 'SubagentStart')
    ).toHaveLength(32)
    expect(
      lifecyclePosts().some(
        (post) => post.body.payload.agent_id === expectedAgentId('child-cap-32')
      )
    ).toBe(false)

    await handler({
      event: { type: 'session.idle', properties: { sessionID: 'child-cap-0' } }
    })
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-cap-32', status: { type: 'busy' } }
      }
    })

    expect(
      lifecyclePosts().filter((post) => post.body.payload.hook_event_name === 'SubagentStart')
    ).toHaveLength(33)
    expect(lifecyclePosts().at(-1)?.body.payload).toMatchObject({
      hook_event_name: 'SubagentStart',
      agent_id: expectedAgentId('child-cap-32')
    })
  })

  it('keeps child messages isolated while root message previews still flow', async () => {
    const handler = await loadPluginEventHandler()
    await handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-message', parentID: 'session-1' } }
      }
    })

    for (const [sessionID, messageID] of [
      ['child-message', 'child-message-id'],
      ['session-1', 'root-message-id']
    ]) {
      await handler({
        event: {
          type: 'message.updated',
          properties: { sessionID, info: { id: messageID, role: 'user' } }
        }
      })
      await handler({
        event: {
          type: 'message.part.updated',
          properties: {
            sessionID,
            part: { type: 'text', text: `${sessionID} text`, messageID }
          }
        }
      })
    }

    expect(messagePartPosts()).toHaveLength(1)
    expect(messagePartPosts()[0].body.payload).toMatchObject({
      sessionID: 'session-1',
      text: 'session-1 text'
    })
  })
})
