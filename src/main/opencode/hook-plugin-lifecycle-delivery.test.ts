/**
 * Executes the generated OpenCode plugin source because this delivery state
 * lives inside OpenCode's process, not in Orca's TypeScript runtime.
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
  app: { getPath: getPathMock }
}))

import { _internals } from './hook-service'

type SessionFixture = { id: string; parentID?: string }
type PluginEvent = { type: string; properties?: Record<string, unknown> }
type PluginEventHandler = (input: { event: PluginEvent }) => Promise<void>
type PluginHooks = { event: PluginEventHandler; dispose?: () => Promise<void> }
type RecordedPost = {
  hook_event_name: string
  sessionID?: string
}

const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT'
] as const

describe('OpenCode plugin lifecycle delivery', () => {
  let tempDir: string
  let posts: RecordedPost[]
  let savedEnv: Record<string, string | undefined>
  let savedFetch: typeof globalThis.fetch

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-lifecycle-plugin-'))
    posts = []
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    process.env.ORCA_AGENT_HOOK_PORT = '45678'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    savedFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(readPayload(init))
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

  function readPayload(init?: RequestInit): RecordedPost {
    return JSON.parse(String(init?.body)).payload as RecordedPost
  }

  async function loadHooks(
    list: () => Promise<{ data: SessionFixture[] }> = async () => ({
      data: [{ id: 'root' }]
    })
  ): Promise<PluginHooks> {
    return loadHooksWithSession({ list })
  }

  async function loadHooksWithSession(session: object): Promise<PluginHooks> {
    const pluginPath = join(tempDir, 'orca-opencode-status.mjs')
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      OrcaOpenCodeStatusPlugin: (ctx: unknown) => Promise<PluginHooks>
    }
    return module.OrcaOpenCodeStatusPlugin({ client: { session } })
  }

  async function loadHandler(
    list?: () => Promise<{ data: SessionFixture[] }>
  ): Promise<PluginEventHandler> {
    return (await loadHooks(list)).event
  }

  function status(type: 'busy' | 'idle' | 'retry', sessionID = 'root'): PluginEvent {
    return {
      type: 'session.status',
      properties: { sessionID, status: { type } }
    }
  }

  function delta(text: string, field = 'text', sessionID = 'root'): PluginEvent {
    return {
      type: 'message.part.delta',
      properties: {
        sessionID,
        messageID: 'message-assistant',
        partID: 'part-assistant',
        field,
        delta: text
      }
    }
  }

  function names(): string[] {
    return posts.map((post) => post.hook_event_name)
  }

  function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
    if (!signal) {
      return Promise.reject(new Error('missing abort signal'))
    }
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }

  it('maps only root session.created to SessionStart', async () => {
    const handler = await loadHandler()

    await handler({
      event: { type: 'session.created', properties: { info: { id: 'root' } } }
    })
    await handler({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child', parentID: 'root' } }
      }
    })

    expect(posts).toEqual([{ hook_event_name: 'SessionStart', sessionID: 'root' }])
  })

  it('falls back per coordinate when the endpoint file is partial or malformed', async () => {
    const endpointPath = join(tempDir, 'endpoint.env')
    writeFileSync(
      endpointPath,
      'not-an-assignment\nORCA_AGENT_HOOK_TOKEN=file-token\nBROKEN LINE\n'
    )
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 })
    )
    globalThis.fetch = fetchMock as typeof globalThis.fetch
    const handler = await loadHandler()

    await handler({ event: status('busy') })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:45678/hook/opencode')
    expect(new Headers(init?.headers).get('X-Orca-Agent-Hook-Token')).toBe('file-token')
  })

  it('warns once for an unreadable endpoint without exposing hook credentials', async () => {
    process.env.ORCA_AGENT_HOOK_ENDPOINT = tempDir
    process.env.ORCA_AGENT_HOOK_TOKEN = 'fallback-secret-token'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const handler = await loadHandler()
      await handler({ event: status('busy') })
      await handler({ event: delta('still working') })

      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls.flat().join(' ')).not.toContain('fallback-secret-token')
    } finally {
      warn.mockRestore()
    }
  })

  it('preserves FIFO lifecycle order while the first session lookup is delayed', async () => {
    let releaseFirstLookup: (() => void) | undefined
    const firstLookup = new Promise<void>((resolve) => {
      releaseFirstLookup = resolve
    })
    let notifyFirstLookupStarted: (() => void) | undefined
    const firstLookupStarted = new Promise<void>((resolve) => {
      notifyFirstLookupStarted = resolve
    })
    let calls = 0
    const list = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        notifyFirstLookupStarted?.()
        await firstLookup
      }
      return { data: [{ id: 'root' }] }
    })
    const handler = await loadHandler(list)

    const busy = handler({ event: status('busy') })
    await firstLookupStarted
    const idle = handler({ event: status('idle') })

    try {
      // Why: OpenCode does not await event hooks, so the plugin must prevent
      // the later idle lookup from overtaking the blocked busy lookup.
      expect(list).toHaveBeenCalledTimes(1)
      expect(posts).toHaveLength(0)
    } finally {
      releaseFirstLookup?.()
    }

    await Promise.all([busy, idle])
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('retries an undelivered Busy transition after a non-2xx response', async () => {
    vi.useFakeTimers()
    let attempts = 0
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(readPayload(init))
      attempts += 1
      return new Response(null, { status: attempts === 1 ? 503 : 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler()

    await handler({ event: status('busy') })
    expect(names()).toEqual(['SessionBusy'])

    await vi.advanceTimersByTimeAsync(499)
    expect(names()).toEqual(['SessionBusy'])
    await vi.advanceTimersByTimeAsync(1)
    expect(names()).toEqual(['SessionBusy', 'SessionBusy'])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(names()).toEqual(['SessionBusy', 'SessionBusy'])
  })

  it('aborts a hung Busy post before delivering the queued Idle transition', async () => {
    vi.useFakeTimers()
    let attempts = 0
    let firstSignal: AbortSignal | undefined
    let notifyFirstFetchStarted: (() => void) | undefined
    const firstFetchStarted = new Promise<void>((resolve) => {
      notifyFirstFetchStarted = resolve
    })
    globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(readPayload(init))
      attempts += 1
      if (attempts > 1) {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      firstSignal = init?.signal ?? undefined
      notifyFirstFetchStarted?.()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        })
      })
    }) as typeof globalThis.fetch
    const handler = await loadHandler()

    const busy = handler({ event: status('busy') })
    const idle = handler({ event: status('idle') })
    await firstFetchStarted

    expect(firstSignal).toBeDefined()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(names()).toEqual(['SessionBusy'])
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([busy, idle])

    expect(firstSignal?.aborted).toBe(true)
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('lets Idle supersede a pending Busy retry', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = readPayload(init)
      posts.push(payload)
      return new Response(null, {
        status: payload.hook_event_name === 'SessionBusy' ? 503 : 204
      })
    }) as typeof globalThis.fetch
    const handler = await loadHandler()

    await handler({ event: status('busy') })
    await handler({ event: status('idle') })
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])

    // Why: a stale retry must not resurrect Working after OpenCode is done.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('uses a current nonempty text delta to retry a dirty Busy transition immediately', async () => {
    vi.useFakeTimers()
    let attempts = 0
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(readPayload(init))
      attempts += 1
      return new Response(null, { status: attempts === 1 ? 503 : 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler()

    await handler({ event: status('busy') })
    expect(names()).toEqual(['SessionBusy'])

    // Why: current OpenCode streams deltas after an empty text-start part; the
    // live delta proves work continued and should recover a lost Busy post.
    await handler({ event: delta('hello') })
    expect(names()).toEqual(['SessionBusy', 'SessionBusy'])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(names()).toEqual(['SessionBusy', 'SessionBusy'])
  })

  it('keeps backoff across OpenCode canonical and deprecated Idle duplicates', async () => {
    vi.useFakeTimers()
    let idleAttempts = 0
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = readPayload(init)
      posts.push(payload)
      if (payload.hook_event_name === 'SessionIdle') {
        idleAttempts += 1
        return new Response(null, { status: idleAttempts === 1 ? 503 : 204 })
      }
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler()

    await handler({ event: status('busy') })
    await handler({ event: status('idle') })
    await handler({
      event: { type: 'session.idle', properties: { sessionID: 'root' } }
    })
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])

    await vi.advanceTimersByTimeAsync(499)
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
    await vi.advanceTimersByTimeAsync(1)
    expect(names()).toEqual(['SessionBusy', 'SessionIdle', 'SessionIdle'])
  })

  it('uses repeated Busy evidence to retry the same dirty state immediately', async () => {
    vi.useFakeTimers()
    let attempts = 0
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(readPayload(init))
      attempts += 1
      return new Response(null, { status: attempts === 1 ? 503 : 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler()

    await handler({ event: status('busy') })
    await handler({ event: status('retry') })
    expect(names()).toEqual(['SessionBusy', 'SessionBusy'])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(names()).toEqual(['SessionBusy', 'SessionBusy'])
  })

  it('does not turn empty or non-text deltas into immediate retry traffic', async () => {
    vi.useFakeTimers()
    let attempts = 0
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(readPayload(init))
      attempts += 1
      return new Response(null, { status: attempts === 1 ? 503 : 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler()

    await handler({ event: status('busy') })
    await handler({ event: delta('reasoning', 'reasoning') })
    await handler({ event: delta('') })
    expect(names()).toEqual(['SessionBusy'])

    await vi.advanceTimersByTimeAsync(499)
    expect(names()).toEqual(['SessionBusy'])
    await vi.advanceTimersByTimeAsync(1)
    expect(names()).toEqual(['SessionBusy', 'SessionBusy'])
  })

  it('backs off exponentially and caps outage retries at thirty seconds', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(readPayload(init))
      return new Response(null, { status: 503 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler()

    await handler({ event: status('busy') })
    expect(names()).toHaveLength(1)

    const retryDelays = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
    for (const [index, delay] of retryDelays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(names()).toHaveLength(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(names()).toHaveLength(index + 2)
    }
  })

  it('fails Busy open after a hung lookup and still lets queued Idle proceed', async () => {
    vi.useFakeTimers()
    let releaseLookup: (() => void) | undefined
    const blockedLookup = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    let calls = 0
    const list = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        await blockedLookup
      }
      return { data: [{ id: 'root' }] }
    })
    const handler = await loadHandler(list)
    const busy = handler({ event: status('busy') })
    const idle = handler({ event: status('idle') })

    await vi.advanceTimersByTimeAsync(1_999)
    expect(list).toHaveBeenCalledTimes(1)
    expect(posts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    try {
      expect(list).toHaveBeenCalledTimes(2)
      // Busy is safe to fail open: even a child means its root is working.
      // Idle still requires a later confirmed-root lookup.
      expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
    } finally {
      releaseLookup?.()
    }
    await Promise.all([busy, idle])
  })

  it('aborts a hung current-SDK point lookup through its second options argument', async () => {
    vi.useFakeTimers()
    let capturedParameters: unknown
    let capturedSignal: AbortSignal | undefined
    function get(parameters: unknown, options: { signal?: AbortSignal }) {
      capturedParameters = parameters
      capturedSignal = options?.signal
      return rejectWhenAborted(capturedSignal)
    }
    const hooks = await loadHooksWithSession({
      get,
      list: async () => ({ data: [{ id: 'root' }] })
    })

    const busy = hooks.event({ event: status('busy') })
    await vi.advanceTimersByTimeAsync(2_000)
    await busy

    expect(capturedParameters).toEqual({ sessionID: 'root' })
    expect(capturedSignal?.aborted).toBe(true)
    expect(names()).toEqual(['SessionBusy'])
  })

  it('aborts a hung legacy-SDK point lookup through its one-object argument', async () => {
    vi.useFakeTimers()
    let capturedOptions: { path?: { id?: string }; signal?: AbortSignal } | undefined
    function get(options: { path?: { id?: string }; signal?: AbortSignal }) {
      capturedOptions = options
      return rejectWhenAborted(options.signal)
    }
    const hooks = await loadHooksWithSession({
      get,
      list: async () => ({ data: [{ id: 'root' }] })
    })

    const busy = hooks.event({ event: status('busy') })
    await vi.advanceTimersByTimeAsync(2_000)
    await busy

    expect(capturedOptions?.path).toEqual({ id: 'root' })
    expect(capturedOptions?.signal?.aborted).toBe(true)
    expect(names()).toEqual(['SessionBusy'])
  })

  it('aborts a hung current-SDK list fallback through its second options argument', async () => {
    vi.useFakeTimers()
    let capturedParameters: unknown
    let capturedSignal: AbortSignal | undefined
    function list(parameters: unknown, options: { signal?: AbortSignal }) {
      capturedParameters = parameters
      capturedSignal = options?.signal
      return rejectWhenAborted(capturedSignal)
    }
    const hooks = await loadHooksWithSession({ list })

    const busy = hooks.event({ event: status('busy') })
    await vi.advanceTimersByTimeAsync(2_000)
    await busy

    expect(capturedParameters).toEqual({})
    expect(capturedSignal?.aborted).toBe(true)
    expect(names()).toEqual(['SessionBusy'])
  })

  it('aborts a hung legacy-SDK list fallback through its one-object argument', async () => {
    vi.useFakeTimers()
    let capturedOptions: { signal?: AbortSignal } | undefined
    function list(options: { signal?: AbortSignal }) {
      capturedOptions = options
      return rejectWhenAborted(options.signal)
    }
    const hooks = await loadHooksWithSession({ list })

    const busy = hooks.event({ event: status('busy') })
    await vi.advanceTimersByTimeAsync(2_000)
    await busy

    expect(capturedOptions?.signal?.aborted).toBe(true)
    expect(names()).toEqual(['SessionBusy'])
  })

  it('does not let a failed Busy retry overwrite delivered permission attention', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = readPayload(init)
      posts.push(payload)
      const firstBusy = payload.hook_event_name === 'SessionBusy' && names().length === 1
      return new Response(null, { status: firstBusy ? 503 : 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler()

    await handler({ event: status('busy') })
    await handler({
      event: { type: 'permission.asked', properties: { id: 'permission-1', sessionID: 'root' } }
    })
    expect(names()).toEqual(['SessionBusy', 'PermissionRequest'])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(names()).toEqual(['SessionBusy', 'PermissionRequest'])
  })

  it('coalesces sustained text-delta recovery before returning to backoff', async () => {
    vi.useFakeTimers()
    let attempts = 0
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(readPayload(init))
      attempts += 1
      return new Response(null, { status: attempts < 3 ? 503 : 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler()

    await handler({ event: status('busy') })
    await handler({ event: delta('stream-0') })
    for (let index = 1; index < 50; index += 1) {
      await handler({ event: delta(`stream-${String(index)}`) })
    }
    expect(names()).toEqual(['SessionBusy', 'SessionBusy'])

    await vi.advanceTimersByTimeAsync(999)
    expect(names()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(names()).toEqual(['SessionBusy', 'SessionBusy', 'SessionBusy'])
  })

  it('cancels lifecycle retries when OpenCode disposes the plugin', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(readPayload(init))
      return new Response(null, { status: 503 })
    }) as typeof globalThis.fetch
    const hooks = await loadHooks()

    await hooks.event({ event: status('busy') })
    expect(hooks.dispose).toBeTypeOf('function')
    await hooks.dispose?.()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(names()).toEqual(['SessionBusy'])
  })

  it('publishes final Idle when the last busy factory is disposed', async () => {
    const hooks = await loadHooks()

    await hooks.event({ event: status('busy') })
    await hooks.dispose?.()

    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('publishes final Idle when MessagePart alone made the disposed factory Working', async () => {
    const hooks = await loadHooks()
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: { sessionID: 'root', info: { id: 'user-message', role: 'user' } }
      }
    })
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'root',
          part: { type: 'text', text: 'prompt before busy', messageID: 'user-message' }
        }
      }
    })

    await hooks.dispose?.()

    expect(names()).toEqual(['MessagePart', 'SessionIdle'])
  })

  it('reasserts an already-delivered Idle after a later MessagePart', async () => {
    const hooks = await loadHooks()
    await hooks.event({ event: status('busy') })
    await hooks.event({ event: status('idle') })
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: { sessionID: 'root', info: { id: 'user-message', role: 'user' } }
      }
    })
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'root',
          part: { type: 'text', text: 'late prompt', messageID: 'user-message' }
        }
      }
    })

    await hooks.dispose?.()

    expect(names()).toEqual(['SessionBusy', 'SessionIdle', 'MessagePart', 'SessionIdle'])
  })

  it('lets OpenCode duplicate Idle supersede a later-delivered MessagePart', async () => {
    const hooks = await loadHooks()
    await hooks.event({ event: status('busy') })
    await hooks.event({ event: status('idle') })
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: { sessionID: 'root', info: { id: 'user-message', role: 'user' } }
      }
    })
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'root',
          part: { type: 'text', text: 'late prompt', messageID: 'user-message' }
        }
      }
    })

    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'root' } } })

    expect(names()).toEqual(['SessionBusy', 'SessionIdle', 'MessagePart', 'SessionIdle'])
  })

  it('does not treat a failed MessagePart attempt as delivered Working authority', async () => {
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = readPayload(init)
      posts.push(payload)
      return new Response(null, {
        status: payload.hook_event_name === 'MessagePart' ? 503 : 204
      })
    }) as typeof globalThis.fetch
    const hooks = await loadHooks()
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: { sessionID: 'root', info: { id: 'user-message', role: 'user' } }
      }
    })
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'root',
          part: { type: 'text', text: 'undelivered prompt', messageID: 'user-message' }
        }
      }
    })

    await hooks.dispose?.()

    expect(names()).toEqual(['MessagePart'])
  })

  it('does not publish a MessagePart after its factory is disposed during lookup', async () => {
    let releaseLookup: (() => void) | undefined
    const blockedLookup = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    let calls = 0
    const list = vi.fn(async () => {
      calls += 1
      if (calls === 2) {
        await blockedLookup
      }
      return { data: [{ id: 'seed' }, { id: 'root' }] }
    })
    const hooks = await loadHooks(list)
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: { sessionID: 'seed', info: { id: 'user-message', role: 'user' } }
      }
    })

    const latePart = hooks.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'root',
          part: { type: 'text', text: 'late prompt', messageID: 'user-message' }
        }
      }
    })
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await hooks.dispose?.()
    releaseLookup?.()
    await latePart

    expect(names()).toEqual([])
  })

  it('drops a disposed factory pending preview while another factory stays active', async () => {
    vi.useFakeTimers()
    const first = await loadHooks()
    const second = await loadHooks()
    await first.event({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'root',
          info: { id: 'assistant-message', role: 'assistant' }
        }
      }
    })
    const part = (text: string): PluginEvent => ({
      type: 'message.part.updated',
      properties: {
        sessionID: 'root',
        part: { type: 'text', text, messageID: 'assistant-message' }
      }
    })

    await first.event({ event: part('first preview') })
    await first.event({ event: part('pending preview') })
    await first.dispose?.()
    await vi.advanceTimersByTimeAsync(1_000)
    await second.dispose?.()

    expect(names()).toEqual(['MessagePart', 'SessionIdle'])
  })

  it('keeps the pane Busy until every concurrent root session is idle', async () => {
    const sessions = [{ id: 'root-a' }, { id: 'root-b' }]
    const handler = await loadHandler(async () => ({ data: sessions }))

    await handler({ event: status('busy', 'root-a') })
    await handler({ event: status('busy', 'root-b') })
    await handler({ event: status('idle', 'root-a') })
    expect(names()).not.toContain('SessionIdle')

    await handler({ event: status('idle', 'root-b') })
    expect(names().filter((name) => name === 'SessionIdle')).toHaveLength(1)
    expect(names().at(-1)).toBe('SessionIdle')
  })

  it('reasserts Busy through the refreshed endpoint after a live text delta', async () => {
    const deliveries: { url: string; token: string | null }[] = []
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(readPayload(init))
      deliveries.push({
        url: String(url),
        token: new Headers(init?.headers).get('X-Orca-Agent-Hook-Token')
      })
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const handler = await loadHandler()

    await handler({ event: status('busy') })
    process.env.ORCA_AGENT_HOOK_PORT = '56789'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'refreshed-token'
    await handler({ event: delta('still working') })

    expect(names()).toEqual(['SessionBusy', 'SessionBusy'])
    expect(deliveries).toEqual([
      { url: 'http://127.0.0.1:45678/hook/opencode', token: 'test-token' },
      { url: 'http://127.0.0.1:56789/hook/opencode', token: 'refreshed-token' }
    ])
  })

  it('clears unanswered question attention on authoritative root Idle', async () => {
    const handler = await loadHandler()

    await handler({ event: status('busy') })
    await handler({
      event: { type: 'question.asked', properties: { id: 'question-1', sessionID: 'root' } }
    })
    expect(names().at(-1)).toBe('AskUserQuestion')

    // OpenCode can finish the question tool without question.replied.
    await handler({ event: status('idle') })
    expect(names().at(-1)).toBe('SessionIdle')
  })
})
