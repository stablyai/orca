import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/manifest/plugin-manifest'
import { invokePluginWorkerCommand } from './plugin-command-invocation'
import { claimPluginReplacedActionRun } from './plugin-command-replacement-deadline'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerHandle } from './workers/plugin-host-process-types'

const pluginKey = 'acme.sidebar'
const manifest = pluginManifestSchema.parse({
  manifestVersion: 2,
  execution: 'trusted-worker',
  id: 'sidebar',
  publisher: 'acme',
  name: 'Sidebar',
  version: '1.0.0',
  engines: { orca: '>=1.4.248' },
  main: 'worker.mjs',
  contributes: {
    commands: [{ id: 'toggle', title: 'Toggle', replaces: 'sidebar.left.toggle' }]
  }
})
const plugin: ValidDiscoveredPlugin = {
  pluginKey,
  rootDir: '/plugins/sidebar',
  manifest,
  consentFingerprint: 'consent',
  contentHash: 'content',
  isDev: false
}

function workerHandle(invokeCommand: () => Promise<unknown>): PluginWorkerHandle {
  return {
    commands: ['toggle'],
    invokeCommand,
    deliverEvent: () => undefined,
    requestFromPanel: async () => undefined,
    runHook: async () => undefined,
    notifyDataChanged: () => undefined,
    lastActivityAt: () => 0,
    inFlightCount: () => 0,
    dispose: async () => undefined,
    kill: () => undefined,
    onExit: () => undefined
  }
}

/** Invokes the replacing command as the renderer does, with a 2 s deadline. */
function invokeReplacement(invokeCommand: () => Promise<unknown>) {
  const handle = workerHandle(invokeCommand)
  return invokePluginWorkerCommand(
    pluginKey,
    plugin,
    { ensure: async () => handle },
    'toggle',
    undefined,
    Date.now() + 2_000
  ).then(
    () => 'ok' as const,
    () => 'fell back' as const
  )
}

/** A handler that waits until the test calls `finish`, then runs the built-in via commands.run. */
function slowReplacement() {
  const ranBuiltIn = vi.fn()
  const refused = vi.fn()
  let finish = (): void => undefined
  const released = new Promise<void>((resolve) => {
    finish = resolve
  })
  let handlerDone: Promise<void> = Promise.resolve()
  const outcome = invokeReplacement(() => {
    handlerDone = released.then(() => {
      try {
        claimPluginReplacedActionRun(pluginKey, 'sidebar.left.toggle')
        ranBuiltIn()
      } catch (error) {
        refused(error)
      }
    })
    return handlerDone
  })
  return {
    outcome,
    ranBuiltIn,
    refused,
    finish: async () => {
      finish()
      await handlerDone
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a plugin command replacing a built-in action', () => {
  it('refuses the late handler’s commands.run once the deadline made Orca run its own', async () => {
    const run = slowReplacement()
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(run.outcome).resolves.toBe('fell back')
    await run.finish()
    expect(run.ranBuiltIn).not.toHaveBeenCalled()
    expect(run.refused).toHaveBeenCalledTimes(1)
  })

  it('lets a handler that finishes in time run the action', async () => {
    const run = slowReplacement()
    await vi.advanceTimersByTimeAsync(500)
    await run.finish()
    await expect(run.outcome).resolves.toBe('ok')
    expect(run.ranBuiltIn).toHaveBeenCalledTimes(1)
  })

  it('does not fall back once the handler already ran the action itself', async () => {
    let crash = (): void => undefined
    const crashed = new Promise<void>((resolve) => {
      crash = resolve
    })
    const outcome = invokeReplacement(async () => {
      claimPluginReplacedActionRun(pluginKey, 'sidebar.left.toggle')
      await crashed
      throw new Error('crashed afterwards')
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(outcome).resolves.toBe('ok')
    crash()
  })

  it('leaves commands.run alone outside a replacement run', () => {
    expect(() => claimPluginReplacedActionRun(pluginKey, 'sidebar.left.toggle')).not.toThrow()
  })
})
