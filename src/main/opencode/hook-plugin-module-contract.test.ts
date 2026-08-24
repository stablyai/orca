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
 * module default export. The shipped loader CALLS the default export as the plugin
 * factory (`defaultExport(input)`), so an object default crashes every launch with
 * `TypeError: fn3 is not a function` (orca #15897 / #16245). These tests execute the
 * generated module so the shipped file is checked against both loaders, not a substring.
 */
describe('OpenCode status plugin module contract', () => {
  type PluginHooks = {
    event: (input: { event: unknown }) => Promise<void>
    dispose?: () => Promise<void>
  }
  type PluginModule = {
    default?: (ctx: unknown) => Promise<PluginHooks>
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

  it('exposes a callable default export identical to the named factory', async () => {
    const module = await loadPluginModule()

    expect(module.default).toBeTypeOf('function')
    expect(module.default).toBe(module.OrcaOpenCodeStatusPlugin)
  })

  it('rejects the object default that crashes the default-export loader', async () => {
    const module = await loadPluginModule()

    // Why: pins the defect behind orca #15897 / #16245 — the loader invokes the default
    // as `defaultExport(input)`, so an `{ id, server }` object throws
    // `TypeError: fn3 is not a function` and breaks every OpenCode launch.
    expect(typeof module.default).not.toBe('object')
  })

  it('keeps the named factory export so the factory-based loader still resolves', async () => {
    const module = await loadPluginModule()

    expect(module.OrcaOpenCodeStatusPlugin).toBeTypeOf('function')
  })

  it('returns an event handler when the loader calls the default export, like the named factory', async () => {
    const module = await loadPluginModule()

    const fromDefault = await module.default?.({})
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
    const hooks = await module.default?.({
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
