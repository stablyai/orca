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
 * module default export. The default-export loader rejects the module outright unless
 * the default is an object exposing `server()` — verified against opencode 1.18.18,
 * which logs `failed to load plugin … must default export an object with server()` for
 * a default of `{ id, setup }` and accepts `{ id, server }`. These tests execute the
 * generated module so the shipped file is checked against both loaders, not a substring.
 */
describe('OpenCode status plugin module contract', () => {
  type PluginHooks = {
    event: (input: { event: unknown }) => Promise<void>
    dispose?: () => Promise<void>
  }
  type PluginModule = {
    default?: {
      id?: unknown
      server?: (ctx: unknown, options?: unknown) => Promise<PluginHooks>
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: generated module is intentionally validated through the runtime assertions below.
    return (await import(pathToFileURL(pluginPath).href)) as PluginModule
  }

  /** Exact shape used by OpenCode's versioned v1 loader: the default module
   * object is validated, then server(input, options) is awaited and its hooks
   * receive the EventV2 bridge envelope. */
  async function invokeSupportedV1Loader(module: PluginModule): Promise<PluginHooks> {
    const candidate = module.default
    if (!candidate || typeof candidate !== 'object' || typeof candidate.server !== 'function') {
      throw new Error('unsupported OpenCode plugin module')
    }
    return candidate.server({ client: {} }, { source: 'contract-test' })
  }

  it('exposes a default export carrying a string id and a callable server()', async () => {
    const module = await loadPluginModule()

    expect(module.default).toBeTypeOf('object')
    expect(typeof module.default?.id).toBe('string')
    expect(module.default?.id).toBe('orca-opencode-status')
    expect(module.default?.server).toBeTypeOf('function')
  })

  it('matches the supported loader and event bridge contract', async () => {
    process.env.ORCA_PANE_KEY = 'tab-v2:leaf-1'
    const posts: { body: unknown }[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double matches fetch's callable shape for this contract test.
    globalThis.fetch = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      posts.push({ body: JSON.parse(String(init?.body ?? '{}')) })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fetch mock only needs the Response.ok field consumed by generated plugin.
      return { ok: true } as Response
    }) as unknown as typeof globalThis.fetch
    const module = await loadPluginModule()
    // Mirrors the vendor readV1Plugin/applyPlugin path: it validates a default
    // object with server(), invokes server(input), then forwards EventV2Bridge's
    // { id, type, properties } envelope to the returned hook.
    const hooks = await invokeSupportedV1Loader(module)
    await hooks.event({
      event: {
        id: 'evt-1',
        type: 'session.status',
        properties: { sessionID: 'ses-v2', status: { type: 'busy' } }
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(posts.some(({ body }) => JSON.stringify(body).includes('SessionBusy'))).toBe(true)
  })

  it('rejects the shape OpenCode refuses: a default export without server()', async () => {
    const module = await loadPluginModule()

    // Why: pins the specific reason the loader fails a module — `setup` alone is not
    // accepted, so a default export must never regress to it.
    expect(module.default).not.toBeUndefined()
    expect(Object.hasOwn(module.default ?? {}, 'server')).toBe(true)
    expect(_internals.getOpenCodePluginSource()).not.toContain('event.subscribe')
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
