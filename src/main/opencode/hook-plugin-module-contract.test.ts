import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { _internals } from './hook-service'

/**
 * OpenCode loads a plugin file either through a named factory export or through the
 * module default export. The pre-v2 default-export loader rejects the module outright
 * unless the default is an object exposing `server()` — verified against opencode
 * 1.18.18, which logs `failed to load plugin … must default export an object with
 * server()` for a default of `{ id, setup }` and accepts `{ id, server }`. The v2
 * loader (opencode 2.x) inverts this: it rejects `{ id, server }` with `Missing key
 * at ["default"]["effect"]` / `Missing key at ["default"]["setup"]` and requires a
 * `setup()` (or `effect`) function. The default therefore carries both keys pointing
 * at the same implementation. These tests execute the generated module so the shipped
 * file is checked against both loaders, not a substring.
 */
describe('OpenCode status plugin module contract', () => {
  type PluginHooks = {
    event: (input: { event: unknown }) => Promise<void>
    dispose?: () => Promise<void>
  }
  type PluginModule = {
    default?: {
      id?: unknown
      server?: (ctx: unknown) => Promise<PluginHooks>
      setup?: (ctx: unknown) => Promise<unknown>
    }
    OrcaOpenCodeStatusPlugin?: (ctx: unknown) => Promise<PluginHooks>
  }

  // Why: the plugin resolves hook coords from the endpoint file first and only then from
  // env. Pin every input here so the run does not depend on the developer's Orca session
  // (an inherited ORCA_AGENT_HOOK_ENDPOINT would otherwise redirect the post to a live app).
  const ENV_KEYS = [
    'ORCA_PANE_KEY',
    'ORCA_AGENT_HOOK_ENDPOINT',
    'ORCA_AGENT_HOOK_PORT',
    'ORCA_AGENT_HOOK_TOKEN'
  ] as const

  let tempDir: string
  let savedFetch: typeof globalThis.fetch
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-plugin-contract-'))
    savedFetch = globalThis.fetch
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    process.env.ORCA_AGENT_HOOK_PORT = '59999'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
  })

  afterEach(() => {
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

  async function loadPluginModule(): Promise<PluginModule> {
    // Why: a unique basename per load defeats the ESM module cache between cases.
    const pluginPath = join(
      tempDir,
      `orca-opencode-status-${Math.random().toString(36).slice(2)}.mjs`
    )
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    return (await import(pathToFileURL(pluginPath).href)) as PluginModule
  }

  it('exposes a default export carrying a string id and a callable server()', async () => {
    const module = await loadPluginModule()

    expect(module.default).toBeTypeOf('object')
    expect(typeof module.default?.id).toBe('string')
    expect(module.default?.id).toBe('orca-opencode-status')
    expect(module.default?.server).toBeTypeOf('function')
  })

  it('rejects the shape OpenCode refuses: a default export without server()', async () => {
    const module = await loadPluginModule()

    // Why: pins the specific reason the pre-v2 loader fails a module — a default
    // export must never regress to dropping `server`, even though the v2 loader
    // additionally requires `setup`.
    expect(module.default).not.toBeUndefined()
    expect(Object.hasOwn(module.default ?? {}, 'server')).toBe(true)
  })

  it('exposes a callable setup() on the default export alongside server()', async () => {
    const module = await loadPluginModule()

    // Why: the v2 loader rejects a default of `{ id, server }` with `Missing key
    // at ["default"]["effect"]` / `Missing key at ["default"]["setup"]`, so the
    // default must carry `setup` too — pointing at the same implementation, not a
    // second copy.
    expect(module.default?.setup).toBeTypeOf('function')
    expect(module.default?.server).toBeTypeOf('function')
    expect(typeof module.default?.id).toBe('string')
  })

  it('setup without an event stream is a side-effect-free no-op', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts: { url: string; body: unknown }[] = []
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return { ok: true } as Response
    }) as unknown as typeof globalThis.fetch

    const module = await loadPluginModule()
    // Why: a pre-v2 context has no `event.subscribe` — setup must not instantiate
    // the factory there (that would spawn a ghost owner that never receives
    // events). The v1 `server` factory owns the lifecycle on such loaders.
    const cleanup = await module.default?.setup?.({})

    expect(cleanup).toBeTypeOf('function')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(posts.filter((post) => post.url.includes('/hook/opencode'))).toHaveLength(0)
  })

  it('reports a v2 session.status event through the hook endpoint when driven via setup()', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts: { url: string; body: unknown }[] = []
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return { ok: true } as Response
    }) as unknown as typeof globalThis.fetch

    // Why: encoded OpenCodeEvent envelope — payload under `data`, not v1's
    // `properties`. A verbatim forward would silently drop this event.
    const busyEvent = {
      id: 'evt_1',
      type: 'session.status',
      data: { sessionID: 'ses_root', status: { type: 'busy' } }
    }
    // Why: v2-style session domain — single-argument get returning the raw info
    // without a `.data` wrapper. This exercises the client shim's normalization.
    const fakeCtx = {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          parentID: undefined
        })
      },
      event: {
        subscribe: async function* () {
          yield busyEvent
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
    }

    const module = await loadPluginModule()
    const cleanup = await module.default?.setup?.(fakeCtx)

    const hookName = (post: { body: unknown }): unknown =>
      (post.body as { payload?: { hook_event_name?: unknown } })?.payload?.hook_event_name

    expect(cleanup).toBeTypeOf('function')
    // Why: the setup subscription loop and lifecycle FIFO drain asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 150))

    const hookPosts = posts.filter((post) => post.url.includes('/hook/opencode'))
    expect(hookPosts.some((post) => hookName(post) === 'SessionBusy')).toBe(true)
    expect(hookPosts[0]?.body).toMatchObject({ paneKey: 'tab-1:leaf-1' })

    // Why: the stream ends when the generator returns — the adapter must dispose
    // the factory then (not only on loader cleanup), otherwise the busy owner
    // could never clear. Dispose of a busy owner publishes the final idle.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const afterStreamEnd = posts.filter((post) => post.url.includes('/hook/opencode'))
    expect(afterStreamEnd.some((post) => hookName(post) === 'SessionIdle')).toBe(true)

    await (cleanup as () => Promise<unknown>)?.()
  })

  it('maps a flat v2 session.created to SessionStart and drops unmapped v2 text events', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts: { url: string; body: unknown }[] = []
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return { ok: true } as Response
    }) as unknown as typeof globalThis.fetch

    // Why: v2 reports the session flat (`data.id`) where v1 nests it under
    // `properties.info`; `session.text.delta` has no v1 counterpart and must
    // never reach the message-preview path (no role/message identity there).
    const fakeCtx = {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          parentID: undefined
        })
      },
      event: {
        subscribe: async function* () {
          yield { id: 'evt_1', type: 'session.created', data: { id: 'ses_root' } }
          yield {
            id: 'evt_2',
            type: 'session.text.delta',
            data: { sessionID: 'ses_root', delta: 'hello' }
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
    }

    const module = await loadPluginModule()
    const cleanup = await module.default?.setup?.(fakeCtx)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await (cleanup as () => Promise<unknown>)?.()

    const hookPosts = posts.filter((post) => post.url.includes('/hook/opencode'))
    const names = hookPosts.map(
      (post) =>
        (post.body as { payload?: { hook_event_name?: unknown } })?.payload?.hook_event_name
    )
    expect(names).toContain('SessionStart')
    // Why: the delta must not surface as a preview post or flip status to busy —
    // only the SessionStart post is legitimate here (stream-end dispose publishes
    // no idle because the factory never owned delivery).
    expect(names).toEqual(['SessionStart'])
  })

  it('keeps the named factory export so the factory-based loader still resolves', async () => {
    const module = await loadPluginModule()

    expect(module.OrcaOpenCodeStatusPlugin).toBeTypeOf('function')
  })

  it('returns an event handler from the default export server(), like the named factory', async () => {
    const module = await loadPluginModule()

    const fromDefault = await module.default?.server?.({})
    const fromNamed = await module.OrcaOpenCodeStatusPlugin?.({})

    expect(fromDefault?.event).toBeTypeOf('function')
    expect(fromNamed?.event).toBeTypeOf('function')
  })

  it('reports a session lifecycle event through the hook endpoint when driven via the default export', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts: { url: string; body: unknown }[] = []
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return { ok: true } as Response
    }) as unknown as typeof globalThis.fetch

    const module = await loadPluginModule()
    const hooks = await module.default?.server?.({
      client: {
        session: {
          // Why: a root session (no parentID) must pass the child-session filter,
          // otherwise every event is dropped before it can post.
          get: async () => ({ data: { id: 'ses_root', parentID: undefined } })
        }
      }
    })

    await hooks?.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_root', status: { type: 'busy' } }
      }
    })
    // Why: lifecycle delivery is queued; let the plugin's FIFO drain before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const hookPosts = posts.filter((post) => post.url.includes('/hook/opencode'))
    expect(hookPosts.length).toBeGreaterThan(0)
    expect(hookPosts[0]?.body).toMatchObject({
      paneKey: 'tab-1:leaf-1',
      payload: { hook_event_name: 'SessionBusy' }
    })
  })
})
