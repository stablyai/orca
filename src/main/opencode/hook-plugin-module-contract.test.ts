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

  type CapturedPost = { url: string; body: unknown }

  function captureHookPosts(): { posts: CapturedPost[] } {
    // Why: one shared fetch capture so mock-shape changes touch a single site.
    const posts: CapturedPost[] = []
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return { ok: true } as Response
    }) as unknown as typeof globalThis.fetch
    return { posts }
  }

  function hookNames(posts: CapturedPost[]): unknown[] {
    return posts
      .filter((post) => post.url.includes('/hook/opencode'))
      .map(
        (post) =>
          (post.body as { payload?: { hook_event_name?: unknown } })?.payload
            ?.hook_event_name
      )
  }

  function makeV2Ctx(
    events: unknown[],
    get?: (input: { sessionID: string }) => Promise<unknown>
  ): unknown {
    // Why: one shared fake v2 context (single-argument session.get returning raw
    // info, async-generator event stream) so the envelope under test is identical
    // across cases; pass no `get` to simulate a lookup-less context.
    return {
      ...(get ? { session: { get } } : {}),
      event: {
        subscribe: async function* () {
          for (const event of events) yield event
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
    }
  }

  function rootSessionGet(parentID?: string): (input: { sessionID: string }) => Promise<unknown> {
    return async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID })
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
    const { posts } = captureHookPosts()

    const module = await loadPluginModule()
    // Why: a pre-v2 context has no `event.subscribe` — setup must not instantiate
    // the factory there (that would spawn a ghost owner that never receives
    // events). The v1 `server` factory owns the lifecycle on such loaders.
    const cleanup = await module.default?.setup?.({})

    expect(cleanup).toBeTypeOf('function')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(hookNames(posts)).toHaveLength(0)
  })

  it('derives busy/idle/start from v2 execution events when driven via setup()', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const { posts } = captureHookPosts()

    // Why: a normal v2 turn emits NO session.status/session.idle — liveness is
    // `session.execution.started` -> `...succeeded`, each carrying only
    // `{ sessionID }` (observed live on 2.0.7). The adapter must derive the v1
    // busy/idle transitions from those, synthesizing the start anything v1
    // posts at creation, confirmed roots only.
    const fakeCtx = makeV2Ctx(
      [
        { id: 'evt_1', type: 'session.execution.started', data: { sessionID: 'ses_root' } },
        { id: 'evt_2', type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } }
      ],
      rootSessionGet()
    )

    const module = await loadPluginModule()
    const cleanup = await module.default?.setup?.(fakeCtx)

    expect(cleanup).toBeTypeOf('function')
    // Why: the setup subscription loop and lifecycle FIFO drain asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 200))

    const hookPosts = posts.filter((post) => post.url.includes('/hook/opencode'))
    expect(hookPosts.map((post) => hookNames([post])[0])).toEqual([
      'SessionStart',
      'SessionBusy',
      'SessionIdle'
    ])
    expect(hookPosts[0]?.body).toMatchObject({ paneKey: 'tab-1:leaf-1' })

    await (cleanup as () => Promise<unknown>)?.()
  })

  it('maps a real v2 session.created to SessionStart and drops unmapped v2 text events', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const { posts } = captureHookPosts()

    // Why: v2 carries the session id as `data.sessionID` (plus optional
    // `data.parentID`) where v1 nests both under `properties.info`;
    // `session.text.delta` has no v1 counterpart and must never reach the
    // message-preview path (no role/message identity there).
    // Why: no session domain here on purpose — without it the synthesis path
    // cannot fire, so the creation mapping is the only route to SessionStart
    // and this test genuinely pins it (a later execution start for the same
    // session still must not double-post Start).
    const fakeCtx = makeV2Ctx([
      { id: 'evt_1', type: 'session.created', data: { sessionID: 'ses_root' } },
      {
        id: 'evt_2',
        type: 'session.text.delta',
        data: { sessionID: 'ses_root', delta: 'hello' }
      },
      { id: 'evt_3', type: 'session.execution.started', data: { sessionID: 'ses_root' } }
    ])

    const module = await loadPluginModule()
    const cleanup = await module.default?.setup?.(fakeCtx)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await (cleanup as () => Promise<unknown>)?.()

    // Why: the delta must not surface as a preview post; the execution start
    // reuses the creation's Start instead of posting a second one, then flips
    // the pane busy, and stream-end dispose returns it to idle.
    expect(hookNames(posts)).toEqual(['SessionStart', 'SessionBusy', 'SessionIdle'])
  })

  it('never double-posts SessionStart when execution precedes a late creation', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const { posts } = captureHookPosts()

    // Why: the synthesis marks first sight, so a real creation arriving after
    // an execution start for the same session must be skipped, not reposted.
    const fakeCtx = makeV2Ctx(
      [
        { id: 'evt_1', type: 'session.execution.started', data: { sessionID: 'ses_root' } },
        { id: 'evt_2', type: 'session.created', data: { sessionID: 'ses_root' } }
      ],
      rootSessionGet()
    )

    const module = await loadPluginModule()
    const cleanup = await module.default?.setup?.(fakeCtx)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await (cleanup as () => Promise<unknown>)?.()

    expect(hookNames(posts).filter((name) => name === 'SessionStart')).toHaveLength(1)
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
    const { posts } = captureHookPosts()

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
