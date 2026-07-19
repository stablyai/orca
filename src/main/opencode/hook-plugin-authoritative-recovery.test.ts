import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))

import { _internals } from './hook-service'

type SessionFixture = { id: string; parentID?: string }
type PluginEvent = { type: string; properties?: Record<string, unknown> }
type PluginEventHandler = (input: { event: PluginEvent }) => Promise<void>
type RecordedPost = Record<string, unknown> & { hook_event_name: string }

const ENV_KEYS = ['ORCA_PANE_KEY', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN'] as const

describe('OpenCode authoritative status recovery', () => {
  let tempDir: string
  let posts: RecordedPost[]
  let savedEnv: Record<string, string | undefined>
  let savedFetch: typeof globalThis.fetch

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-recovery-'))
    posts = []
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    process.env.ORCA_AGENT_HOOK_PORT = '45678'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    savedFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)).payload as RecordedPost)
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
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

  async function loadHandler(sessions: SessionFixture[]): Promise<PluginEventHandler> {
    const pluginPath = join(tempDir, 'orca-opencode-status.mjs')
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      OrcaOpenCodeStatusPlugin: (ctx: unknown) => Promise<{ event: PluginEventHandler }>
    }
    const hooks = await module.OrcaOpenCodeStatusPlugin({
      client: { session: { list: async () => ({ data: sessions }) } }
    })
    return hooks.event
  }

  function status(sessionID: string, type: 'busy' | 'idle'): PluginEvent {
    return { type: 'session.status', properties: { sessionID, status: { type } } }
  }

  function sessionError(sessionID: string, message: string): PluginEvent {
    return {
      type: 'session.error',
      properties: { sessionID, error: { name: 'UnknownError', data: { message } } }
    }
  }

  function messageUpdated(
    sessionID: string,
    messageID: string,
    role: 'assistant' | 'user'
  ): PluginEvent {
    return {
      type: 'message.updated',
      properties: { sessionID, info: { id: messageID, role } }
    }
  }

  function messagePartUpdated(
    sessionID: string,
    messageID: string,
    text: string,
    synthetic = false
  ): PluginEvent {
    return {
      type: 'message.part.updated',
      properties: {
        sessionID,
        part: { id: `part-${messageID}`, type: 'text', messageID, text, synthetic }
      }
    }
  }

  function names(): string[] {
    return posts.map((post) => post.hook_event_name)
  }

  it('cancels a preflight error when OpenCode continues into busy', async () => {
    vi.useFakeTimers()
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: sessionError('root', 'Could not read attachment') })
    await handler({ event: status('root', 'busy') })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(names()).toEqual(['SessionBusy'])
    await handler({ event: status('root', 'idle') })
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('keeps a recoverable preflight error invisible through delayed noReply completion', async () => {
    vi.useFakeTimers()
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: sessionError('root', 'Could not read attachment') })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(names()).toEqual([])

    // Move/warp noReply saves one synthetic part and emits no busy/idle status.
    await handler({ event: messageUpdated('root', 'message-user', 'user') })
    await handler({
      event: messagePartUpdated('root', 'message-user', 'Session moved', true)
    })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(names()).toEqual([])
  })

  it('replaces a recovered error with ordinary prompt working without an idle flash', async () => {
    vi.useFakeTimers()
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: sessionError('root', 'Command not found') })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(names()).toEqual(['SessionError'])

    await handler({ event: messageUpdated('root', 'message-user', 'user') })
    await handler({
      event: messagePartUpdated('root', 'message-user', 'Please continue')
    })
    await handler({ event: status('root', 'busy') })
    await vi.advanceTimersByTimeAsync(0)

    expect(names()).toEqual(['SessionError', 'MessagePart'])
    expect(posts[1]).toMatchObject({
      role: 'user',
      text: 'Please continue',
      sessionID: 'root'
    })

    await handler({ event: status('root', 'idle') })
    expect(names()).toEqual(['SessionError', 'MessagePart', 'SessionIdle'])
  })

  it('surfaces a serialized prompt failure after a recoverable read error', async () => {
    vi.useFakeTimers()
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: sessionError('root', 'Could not read attachment') })
    await handler({
      event: sessionError('root', 'Error: chat.message plugin exploded\n    at plugin.js:42:7')
    })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(names()).toEqual(['SessionError'])
    expect(posts[0]?.error).toEqual({
      name: 'UnknownError',
      data: { message: 'Error: chat.message plugin exploded\n    at plugin.js:42:7' }
    })
  })

  it('preserves a direct failure across prompt_async generic error reporting', async () => {
    vi.useFakeTimers()
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: sessionError('root', 'Command not found: "/missing"') })
    await handler({
      event: sessionError(
        'root',
        'UnknownError: Command not found: "/missing"\n    at session/prompt.ts:1367:9'
      )
    })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(names()).toEqual(['SessionError'])
    expect(posts[0]?.error).toEqual({
      name: 'UnknownError',
      data: { message: 'Command not found: "/missing"' }
    })
  })

  it('settles a delivered error to idle once for synthetic noReply without working', async () => {
    vi.useFakeTimers()
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: sessionError('root', 'Command not found') })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(names()).toEqual(['SessionError'])

    await handler({ event: messageUpdated('root', 'message-user', 'user') })
    await handler({
      event: messagePartUpdated('root', 'message-user', 'Session moved', true)
    })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(names()).toEqual(['SessionError', 'SessionIdle'])
    expect(names().filter((name) => name === 'SessionIdle')).toHaveLength(1)
    expect(names()).not.toContain('SessionBusy')
    expect(names()).not.toContain('MessagePart')
  })

  it('cancels a failed direct-error delivery retry when root authority recovers', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)).payload as RecordedPost
      posts.push(payload)
      return new Response(null, { status: payload.hook_event_name === 'SessionError' ? 503 : 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: sessionError('root', 'Agent not found') })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(names()).toEqual(['SessionError'])

    await handler({ event: messageUpdated('root', 'message-user', 'user') })
    await handler({
      event: messagePartUpdated('root', 'message-user', 'Session moved', true)
    })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(names()).toEqual(['SessionError', 'SessionIdle'])
  })

  it('retries only recovered idle when clearing a delivered direct failure fails', async () => {
    vi.useFakeTimers()
    let idleAttempts = 0
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)).payload as RecordedPost
      posts.push(payload)
      if (payload.hook_event_name === 'SessionIdle') {
        idleAttempts += 1
        return new Response(null, { status: idleAttempts > 1 ? 204 : 503 })
      }
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: sessionError('root', 'Model not found: test/model') })
    await vi.advanceTimersByTimeAsync(5_000)
    await handler({ event: messageUpdated('root', 'message-user', 'user') })
    await handler({
      event: messagePartUpdated('root', 'message-user', 'Session moved', true)
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(names()).toEqual(['SessionError', 'SessionIdle'])

    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(names()).toEqual(['SessionError', 'SessionIdle', 'SessionIdle'])
  })

  it('retires a recovered preflight outcome without disturbing another root', async () => {
    vi.useFakeTimers()
    let rootBErrorAttempts = 0
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)).payload as RecordedPost
      posts.push(payload)
      if (payload.hook_event_name === 'SessionError' && payload.sessionID === 'root-b') {
        rootBErrorAttempts += 1
        return new Response(null, { status: rootBErrorAttempts > 1 ? 204 : 503 })
      }
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler([{ id: 'root-a' }, { id: 'root-b' }])

    await handler({ event: sessionError('root-a', 'Command not found') })
    await vi.advanceTimersByTimeAsync(5_000)
    await handler({ event: sessionError('root-b', 'Agent not found') })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(posts.map((post) => post.sessionID)).toEqual(['root-a', 'root-b'])

    await handler({ event: messageUpdated('root-a', 'message-user-a', 'user') })
    await handler({
      event: messagePartUpdated('root-a', 'message-user-a', 'Session moved', true)
    })
    expect(names()).toEqual(['SessionError', 'SessionError'])
    expect(posts.at(-1)?.sessionID).toBe('root-b')

    await vi.advanceTimersByTimeAsync(500)
    expect(names()).toEqual(['SessionError', 'SessionError', 'SessionError'])
    expect(posts.at(-1)?.sessionID).toBe('root-b')

    await handler({ event: messageUpdated('root-b', 'message-user-b', 'user') })
    await handler({
      event: messagePartUpdated('root-b', 'message-user-b', 'Session moved', true)
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(names()).toEqual(['SessionError', 'SessionError', 'SessionError', 'SessionIdle'])
    expect(posts.at(-1)?.sessionID).toBe('root-b')
  })

  it('does not let assistant or child messages hide a root preflight error', async () => {
    vi.useFakeTimers()
    const handler = await loadHandler([{ id: 'root' }, { id: 'child', parentID: 'root' }])

    await handler({ event: sessionError('root', 'Command not found') })
    await handler({ event: messageUpdated('root', 'message-assistant', 'assistant') })
    await handler({ event: messageUpdated('child', 'message-child-user', 'user') })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(names()).toEqual(['SessionError'])
  })

  it('surfaces a preflight error after the grace when no lifecycle event follows', async () => {
    vi.useFakeTimers()
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: sessionError('root', 'Command not found') })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(names()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)

    expect(names()).toEqual(['SessionError'])
    expect(posts[0]).toMatchObject({
      sessionID: 'root',
      error: { name: 'UnknownError', data: { message: 'Command not found' } }
    })
  })

  it('promotes a preflight error immediately when its root becomes idle', async () => {
    vi.useFakeTimers()
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: sessionError('root', 'Command not found') })
    await handler({ event: status('root', 'idle') })

    expect(names()).toEqual(['SessionError'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(names()).toEqual(['SessionError'])
  })

  it('keeps another busy root authoritative over a promoted preflight error', async () => {
    vi.useFakeTimers()
    const handler = await loadHandler([{ id: 'preflight' }, { id: 'still-busy' }])

    await handler({ event: status('still-busy', 'busy') })
    await handler({ event: sessionError('preflight', 'Agent not found') })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(names()).toEqual(['SessionBusy'])
    await handler({ event: status('still-busy', 'idle') })
    expect(names()).toEqual(['SessionBusy', 'SessionError'])
    expect(posts.at(-1)?.sessionID).toBe('preflight')
  })

  it('keeps retrying a blocker through an outage longer than the exponential ramp', async () => {
    vi.useFakeTimers()
    let permissionAttempts = 0
    let permissionCanSucceed = false
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)).payload as RecordedPost
      posts.push(payload)
      if (payload.hook_event_name === 'PermissionRequest') {
        permissionAttempts += 1
        return new Response(null, { status: permissionCanSucceed ? 204 : 503 })
      }
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: status('root', 'busy') })
    await handler({
      event: { type: 'permission.asked', properties: { id: 'per_retry', sessionID: 'root' } }
    })
    await vi.advanceTimersByTimeAsync(7_500)
    expect(permissionAttempts).toBe(5)

    permissionCanSucceed = true
    await vi.advanceTimersByTimeAsync(7_999)
    expect(permissionAttempts).toBe(5)
    await vi.advanceTimersByTimeAsync(1)
    expect(permissionAttempts).toBe(6)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(permissionAttempts).toBe(6)
  })

  it('caps durable idle retries at 30s and recovers without rapid traffic', async () => {
    vi.useFakeTimers()
    let idleCanSucceed = false
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)).payload as RecordedPost
      posts.push(payload)
      if (payload.hook_event_name === 'SessionIdle' && !idleCanSucceed) {
        return new Response(null, { status: 503 })
      }
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler([{ id: 'root' }])

    await handler({ event: status('root', 'busy') })
    await handler({ event: status('root', 'idle') })
    await vi.advanceTimersByTimeAsync(31_500)
    expect(names().filter((name) => name === 'SessionIdle')).toHaveLength(7)

    idleCanSucceed = true
    await vi.advanceTimersByTimeAsync(29_999)
    expect(names().filter((name) => name === 'SessionIdle')).toHaveLength(7)
    await vi.advanceTimersByTimeAsync(1)
    expect(names().filter((name) => name === 'SessionIdle')).toHaveLength(8)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(names().filter((name) => name === 'SessionIdle')).toHaveLength(8)
  })
})
