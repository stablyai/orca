import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { runPluginHookChain } from '../../../shared/plugins/workers/plugin-hook-chain'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginWorkerHandle } from '../workers/plugin-host-process'
import { PluginWorkerManager, type PluginWorkerFactory } from '../workers/plugin-worker-manager'
import { buildPluginWorkerSpawnSpec } from '../workers/plugin-worker-spawn-spec'
import { createPluginHookWarmer } from './plugin-hook-participants'

function plugin(
  pluginKey: string,
  hooks: readonly string[],
  fingerprint = 'fp'
): ValidDiscoveredPlugin {
  return {
    pluginKey,
    rootDir: `/plugins/${pluginKey}`,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 2,
      execution: 'trusted-worker',
      id: 'guard',
      name: 'Guard',
      version: '1.0.0',
      engines: { orca: '>=1.4.248' },
      main: 'main.mjs',
      contributes: { hooks: hooks.map((event) => ({ event })) }
    }),
    consentFingerprint: fingerprint,
    contentHash: null,
    isDev: false
  }
}

function worker(): PluginWorkerHandle & { exit(code: number): void } {
  const exits: ((code: number | null) => void)[] = []
  return {
    commands: [],
    invokeCommand: vi.fn(),
    deliverEvent: vi.fn(),
    requestFromPanel: vi.fn(),
    runHook: vi.fn(),
    notifyDataChanged: vi.fn(),
    // Long idle on purpose: only keepWarm stops the reap.
    lastActivityAt: () => 0,
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: (callback) => void exits.push(callback),
    exit: (code) => exits.forEach((callback) => callback(code))
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('hook plugin warming', () => {
  it('starts each enabled hook plugin once per approved revision', () => {
    let plugins = [plugin('acme.guard', ['terminal.send']), plugin('acme.plain', [])]
    const enabled = new Set(['acme.guard', 'acme.plain'])
    const ensureWorker = vi.fn(async () => worker())
    const warm = createPluginHookWarmer({
      plugins: () => plugins,
      isRuntimeApproved: (candidate) => enabled.has(candidate.pluginKey),
      ensureWorker,
      isEnabled: () => true
    })
    warm()
    warm()
    expect(ensureWorker.mock.calls.map(([started]) => started.pluginKey)).toEqual(['acme.guard'])

    plugins = [plugin('acme.guard', ['terminal.send'], 'fp-2')]
    warm()
    enabled.delete('acme.guard')
    warm()
    enabled.add('acme.guard')
    warm()
    expect(ensureWorker).toHaveBeenCalledTimes(3)
  })

  it('keeps a hook plugin’s worker through idle reaping and restarts it after a crash', async () => {
    vi.useFakeTimers()
    const first = worker()
    const second = worker()
    const factory = vi
      .fn<PluginWorkerFactory>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const manager = new PluginWorkerManager({
      entryPath: '/host.js',
      workerFactory: factory,
      idleReapMs: 100,
      executeHostCall: async () => ({ ok: true, value: null }),
      log: () => vi.fn(),
      onWorkerStateChange: vi.fn()
    })
    const spec = buildPluginWorkerSpawnSpec(plugin('acme.guard', ['terminal.send']), [])
    expect(spec.keepWarm).toBe(true)
    await manager.ensureActive(spec)

    manager.reapIdle(10_000)
    expect(first.dispose).not.toHaveBeenCalled()
    expect(manager.runningHandle('acme.guard')).toBe(first)

    first.exit(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(manager.runningHandle('acme.guard')).toBe(second)
    await manager.disposeAll()
  })

  it('bounds worker start by its own timeout, then gives the handler the full deadline', async () => {
    vi.useFakeTimers()
    const logs: string[] = []
    const outcome = runPluginHookChain({
      event: 'terminal.send',
      payload: { terminalId: 't', text: 'rm -rf /', enter: true, inputKind: 'driving' },
      participants: ['acme.slow-start', 'acme.never-starts'],
      start: (pluginKey) =>
        new Promise((resolve) => {
          if (pluginKey === 'acme.slow-start') {
            setTimeout(resolve, 5_000)
          }
        }),
      startTimeoutMs: 10_000,
      invoke: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ decision: 'result', result: { deny: 'no' } }), 1_500)
        ),
      deadlineMs: 2_000,
      log: (pluginKey, line) => void logs.push(`${pluginKey}: ${line}`),
      now: () => 0
    })
    await vi.advanceTimersByTimeAsync(6_500)
    await expect(outcome).resolves.toEqual({
      kind: 'deny',
      pluginKey: 'acme.slow-start',
      reason: 'no'
    })
    expect(logs).toEqual([])
  })

  it('passes a plugin whose worker never starts within the ready timeout', async () => {
    vi.useFakeTimers()
    const logs: string[] = []
    const outcome = runPluginHookChain({
      event: 'terminal.send',
      payload: { terminalId: 't', text: 'ls', enter: true, inputKind: 'driving' },
      participants: ['acme.stuck'],
      start: () => new Promise(() => undefined),
      startTimeoutMs: 10_000,
      invoke: vi.fn(),
      log: (pluginKey, line) => void logs.push(`${pluginKey}: ${line}`),
      now: () => 0
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(outcome).resolves.toMatchObject({ kind: 'continue' })
    expect(logs).toEqual([
      'acme.stuck: hook terminal.send skipped after 0ms: worker did not start after 10000ms'
    ])
  })
})
