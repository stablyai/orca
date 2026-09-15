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
 * module default export. The V1 default-export loader rejects the module outright unless
 * the default is an object exposing `server()` — verified against opencode 1.18.18,
 * which logs `failed to load plugin … must default export an object with server()` for
 * a default of `{ id, setup }` and accepts `{ id, server }`. The OpenCode V2 loader
 * instead requires `id` plus `setup()` (or `effect()`) and ignores `server()`, so the
 * default export carries all three and these tests execute the generated module against
 * both loaders, not a substring.
 */
describe('OpenCode status plugin module contract', () => {
  type PluginHooks = {
    event: (input: { event: unknown }) => Promise<void>
    dispose?: () => Promise<void>
  }
  type PluginHooksCleanup = () => Promise<void>
  type PluginModule = {
    default?: {
      id?: unknown
      server?: (ctx: unknown) => Promise<PluginHooks>
      setup?: (ctx: unknown) => Promise<PluginHooksCleanup>
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

    // Why: pins the specific reason the loader fails a module — `setup` alone is not
    // accepted, so a default export must never regress to it.
    expect(module.default).not.toBeUndefined()
    expect(Object.hasOwn(module.default ?? {}, 'server')).toBe(true)
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

  it('exposes a callable setup() on the default export for the OpenCode V2 loader', async () => {
    const module = await loadPluginModule()

    // Why: OpenCode V2 rejects a plugin whose default export has no `setup` or
    // `effect` — the exact regression that left Orca status dark after the V1 to
    // V2 migration. `server()` stays for V1; `setup()` is the V2 entrypoint.
    expect(module.default?.setup).toBeTypeOf('function')
    expect(module.default?.server).toBeTypeOf('function')
  })

  it('drives session status through setup() over the V2 event stream', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts: { url: string; body: unknown }[] = []
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return { ok: true } as Response
    }) as unknown as typeof globalThis.fetch

    async function* events() {
      yield { type: 'session.created', properties: { info: { id: 'ses_root' } } }
      yield {
        type: 'session.status',
        properties: { sessionID: 'ses_root', status: { type: 'busy' } }
      }
    }
    const ctx = {
      event: { subscribe: () => events() },
      session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }) },
      options: {}
    }

    const module = await loadPluginModule()
    const cleanup = await module.default?.setup?.(ctx)
    expect(cleanup).toBeTypeOf('function')
    // Why: the subscription pump runs in the background; let it drain the stream.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await cleanup?.()

    const hookPosts = posts.filter((post) => post.url.includes('/hook/opencode'))
    expect(hookPosts.length).toBeGreaterThan(0)
    expect(hookPosts.map((post) => (post.body as { payload: { hook_event_name: string } }).payload.hook_event_name)).toContain('SessionBusy')
  })

  it('bridges V2 form.* events to the question attention path through setup()', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts: { url: string; body: unknown }[] = []
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return { ok: true } as Response
    }) as unknown as typeof globalThis.fetch

    // Why: OpenCode V2 removed question.asked/replied/rejected in favour of
    // form.created/replied/cancelled; without this bridge the dashboard never
    // learns a question tool is waiting on the pane owner.
    async function* events() {
      yield {
        type: 'form.created',
        data: { form: { id: 'req-1', sessionID: 'ses_root', title: 'Pick one' } }
      }
    }
    const ctx = {
      event: { subscribe: () => events() },
      session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }) },
      options: {}
    }

    const module = await loadPluginModule()
    const cleanup = await module.default?.setup?.(ctx)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await cleanup?.()

    const hookPosts = posts.filter((post) => post.url.includes('/hook/opencode'))
    expect(hookPosts.map((post) => (post.body as { payload: { hook_event_name: string } }).payload.hook_event_name)).toContain('AskUserQuestion')
  })
})
