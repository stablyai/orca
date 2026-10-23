/**
 * Executes the generated plugin through each OpenCode host entry point, because
 * what disposal means differs by host: OpenCode 1 disposes only on instance
 * teardown (which cancels every run), OpenCode 2 also on a plugin hot reload.
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

type PluginHooks = {
  event: (input: { event: unknown }) => Promise<void>
  dispose?: () => Promise<void>
}
type HostEvent = { type: string; data: Record<string, unknown> }
type PluginModule = {
  default?: {
    server?: (ctx: unknown) => Promise<PluginHooks>
    setup?: (ctx: unknown) => Promise<() => Promise<void>>
  }
}

const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_OPENCODE_AGENT',
  'ORCA_OPENCODE_PLUGIN_API',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN'
] as const

// A live OpenCode 2 event bus: stays open until the subscriber aborts.
function createEventBus(): {
  push: (event: HostEvent) => void
  subscribe: (input: { signal: AbortSignal }) => AsyncGenerator<HostEvent>
} {
  const queue: HostEvent[] = []
  let wake: (() => void) | null = null
  return {
    push(event) {
      queue.push(event)
      wake?.()
    },
    async *subscribe({ signal }) {
      while (!signal.aborted) {
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        wake = null
      }
    }
  }
}

describe.each(['opencode', 'opencode2'] as const)('%s plugin disposal by host', (agent) => {
  let tempDir: string
  let savedEnv: Record<string, string | undefined>
  let names: string[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-dispose-host-'))
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    process.env.ORCA_OPENCODE_AGENT = agent
    process.env.ORCA_OPENCODE_PLUGIN_API = 'v2'
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    process.env.ORCA_AGENT_HOOK_PORT = '59999'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    names = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        names.push(String(JSON.parse(String(init?.body)).payload?.hook_event_name))
        return new Response('{}', { status: 200 })
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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
    const pluginPath = join(tempDir, `orca-${agent}-status.mjs`)
    writeFileSync(
      pluginPath,
      agent === 'opencode2'
        ? _internals.getOpenCode2PluginSource()
        : _internals.getOpenCodePluginSource()
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the generated plugin module exports this shape.
    return (await import(pathToFileURL(pluginPath).href)) as PluginModule
  }

  function setupContext(bus: ReturnType<typeof createEventBus>): unknown {
    return {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }),
        hook: async () => ({ dispose: async () => {} })
      },
      event: { subscribe: bus.subscribe }
    }
  }

  it('publishes a final Idle when the OpenCode 1 instance tears down mid-turn', async () => {
    const module = await loadPluginModule()
    const hooks = await module.default?.server?.({
      client: { session: { get: async () => ({ data: { id: 'ses_root' } }) } }
    })
    await hooks?.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_root', status: { type: 'busy' } }
      }
    })
    await hooks?.dispose?.()

    expect(names).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('keeps the pane Working when OpenCode 2 reloads the plugin mid-turn', async () => {
    const module = await loadPluginModule()
    const firstBus = createEventBus()
    const firstCleanup = await module.default?.setup?.(setupContext(firstBus))
    firstBus.push({ type: 'session.execution.started', data: { sessionID: 'ses_root' } })
    await vi.waitFor(() => expect(names).toEqual(['SessionBusy']))

    await firstCleanup?.()
    expect(names).toEqual(['SessionBusy'])

    // The turn kept running; its end reaches the reloaded plugin.
    const secondBus = createEventBus()
    const secondCleanup = await module.default?.setup?.(setupContext(secondBus))
    secondBus.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } })
    await vi.waitFor(() => expect(names).toEqual(['SessionBusy', 'SessionIdle']))
    await secondCleanup?.()
    expect(names).toEqual(['SessionBusy', 'SessionIdle'])
  })
})
