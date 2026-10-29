import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginExtensionRegistry } from '../../shared/plugins/plugin-extension-registry'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { PluginContentVerifier } from './plugin-content-integrity'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginWorkerController } from './plugin-worker-controller'
import type { PluginWorkerFactory } from './plugin-worker-manager'
import { PluginLogBuffer } from './plugin-log-buffer'
import { buildPluginWorkerSpawnSpec } from './plugin-worker-spawn-spec'
import { hashPluginTree } from './plugin-content-hash'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function plugin(): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-worker-controller-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'main.mjs'), 'export default function activate() {}')
  return {
    pluginKey: 'orca-samples.demo',
    rootDir,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'orca-samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      main: 'main.mjs',
      contributes: {
        panels: [],
        commands: [{ id: 'run', title: 'Run' }],
        events: []
      },
      capabilities: []
    }),
    consentFingerprint: 'sha256-current',
    contentHash: null,
    isDev: true
  }
}

function worker(commands: string[]): PluginWorkerHandle & { dispose: ReturnType<typeof vi.fn> } {
  return {
    commands,
    invokeCommand: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: vi.fn()
  }
}

function controller(options: {
  factory: PluginWorkerFactory
  verify: () => Promise<void>
  isApproved: () => boolean
  isApprovalKept?: () => boolean
  logs?: PluginLogBuffer
}): PluginWorkerController {
  const contentVerifier = new PluginContentVerifier()
  contentVerifier.verify = options.verify
  contentVerifier.verifyNow = options.verify
  return new PluginWorkerController({
    entryPath: '/host-entry.js',
    workerFactory: options.factory,
    registry: createPluginExtensionRegistry(),
    contentVerifier,
    capabilities: () => (options.isApproved() ? [] : null),
    isCurrentApproved: () => options.isApproved(),
    isApprovalKept: options.isApprovalKept,
    invokeCommand: vi.fn(async () => null),
    executeHostCall: vi.fn(async () => ({ ok: true as const, value: null })),
    log: (key) => options.logs?.capture(key) ?? vi.fn(),
    onStateChanged: vi.fn(),
    onWorkerGone: vi.fn()
  })
}

describe('PluginWorkerController activation authority', () => {
  it('does not recreate logs or start a revision after uninstall overtakes deactivation', async () => {
    const subjectPlugin = await plugin()
    const logs = new PluginLogBuffer()
    const capture = vi.spyOn(logs, 'capture')
    let approved = true
    let finishStop!: () => void
    const stopped = new Promise<void>((resolve) => {
      finishStop = resolve
    })
    const oldWorker = worker(['run'])
    oldWorker.dispose.mockImplementation(() => stopped)
    const factory = vi.fn<PluginWorkerFactory>().mockResolvedValue(oldWorker)
    const subject = controller({
      factory,
      verify: async () => undefined,
      isApproved: () => approved,
      logs
    })
    await subject.ensure(subjectPlugin)
    logs.append(subjectPlugin.pluginKey, 'info', 'old installation')
    const newRevision = {
      ...subjectPlugin,
      manifest: { ...subjectPlugin.manifest, version: '2.0.0' }
    }
    const staleActivation = subject.ensure(newRevision)
    await vi.waitFor(() => expect(oldWorker.dispose).toHaveBeenCalledOnce())
    approved = false
    await subject.deactivate(subjectPlugin.pluginKey)
    logs.clear(subjectPlugin.pluginKey)
    const capturesBeforeStop = capture.mock.calls.length
    finishStop()

    await expect(staleActivation).rejects.toThrow('no longer approved')
    expect(factory).toHaveBeenCalledOnce()
    expect(capture).toHaveBeenCalledTimes(capturesBeforeStop)
    expect(logs.get(subjectPlugin.pluginKey)).toEqual([])
    await subject.dispose()
  })

  it('keeps restarting a crashed worker through a refresh pause', async () => {
    const subjectPlugin = await plugin()
    vi.useFakeTimers()
    const exits: ((code: number | null) => void)[] = []
    const factory = vi.fn<PluginWorkerFactory>(async () => ({
      ...worker(['run']),
      onExit: (callback) => exits.push(callback)
    }))
    let paused = false
    const subject = controller({
      factory,
      verify: async () => undefined,
      isApproved: () => !paused,
      isApprovalKept: () => true
    })
    try {
      await subject.ensure(subjectPlugin)
      paused = true
      exits[0]?.(1)
      await vi.advanceTimersByTimeAsync(500)

      expect(factory).toHaveBeenCalledTimes(2)
      expect(subject.state(subjectPlugin.pluginKey).state).not.toBe('restarting')
    } finally {
      vi.useRealTimers()
      await subject.dispose()
    }
  })

  it('does not start code after approval is revoked during integrity verification', async () => {
    const subjectPlugin = await plugin()
    let approved = true
    let finishVerification!: () => void
    const verification = new Promise<void>((resolve) => {
      finishVerification = resolve
    })
    const factory = vi.fn<PluginWorkerFactory>()
    const subject = controller({ factory, verify: () => verification, isApproved: () => approved })

    const activation = subject.ensure(subjectPlugin)
    approved = false
    finishVerification()

    await expect(activation).rejects.toThrow('no longer approved')
    expect(factory).not.toHaveBeenCalled()
    await subject.dispose()
  })

  it('disposes a worker whose approval changes while the process starts', async () => {
    const subjectPlugin = await plugin()
    let approved = true
    let finishStart!: (handle: PluginWorkerHandle) => void
    const factory = vi.fn<PluginWorkerFactory>(
      () => new Promise<PluginWorkerHandle>((resolve) => (finishStart = resolve))
    )
    const subject = controller({
      factory,
      verify: async () => undefined,
      isApproved: () => approved
    })
    const startedWorker = worker(['run'])

    const activation = subject.ensure(subjectPlugin)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
    approved = false
    finishStart(startedWorker)

    await expect(activation).rejects.toThrow(/changed or (is no longer approved|was disabled)/)
    expect(startedWorker.dispose).toHaveBeenCalledOnce()
    await subject.dispose()
  })

  it('rejects and stops workers that register undeclared commands', async () => {
    const subjectPlugin = await plugin()
    const startedWorker = worker(['run', 'undeclared'])
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>().mockResolvedValue(startedWorker),
      verify: async () => undefined,
      isApproved: () => true
    })

    await expect(subject.ensure(subjectPlugin)).rejects.toThrow(
      'registered undeclared command undeclared'
    )
    expect(startedWorker.dispose).toHaveBeenCalledOnce()
    await subject.dispose()
  })

  it('rejects workers that register declarative action aliases', async () => {
    const base = await plugin()
    const subjectPlugin: ValidDiscoveredPlugin = {
      ...base,
      manifest: pluginManifestSchema.parse({
        ...base.manifest,
        contributes: {
          ...base.manifest.contributes,
          commands: [{ id: 'tasks', title: 'Tasks', action: 'view.tasks' }]
        }
      })
    }
    const startedWorker = worker(['tasks'])
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>().mockResolvedValue(startedWorker),
      verify: async () => undefined,
      isApproved: () => true
    })

    await expect(subject.ensure(subjectPlugin)).rejects.toThrow(
      'registered undeclared command tasks'
    )
    expect(startedWorker.dispose).toHaveBeenCalledOnce()
    await subject.dispose()
  })

  it('restarts a running worker once when its reviewed bytes change', async () => {
    const current = await plugin()
    const idle = { ...(await plugin()), pluginKey: 'orca-samples.idle' }
    const factory = vi.fn<PluginWorkerFactory>(async () => worker(['run']))
    const subject = controller({ factory, verify: async () => undefined, isApproved: () => true })
    await subject.ensure(current)
    await writeFile(join(current.rootDir, 'main.mjs'), 'export default function activate() { 2 }')
    const reviewed = await hashPluginTree(current.rootDir)
    const updated = { ...current, consentContentHash: reviewed.ok ? reviewed.hash : null }
    const discovered = new Map([updated, idle].map((next) => [next.pluginKey, next]))
    const nextSpecs = new Map(
      [...discovered.values()].map((next) => [next.pluginKey, buildPluginWorkerSpawnSpec(next, [])])
    )
    const resolve = (key: string) => discovered.get(key) ?? null

    await subject.reconcile(nextSpecs, resolve)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    await subject.reconcile(nextSpecs, resolve)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(factory.mock.calls.map(([options]) => options.pluginId)).not.toContain(idle.pluginKey)
    await subject.dispose()
  })

  it('does not start an updated worker after dispose overtakes its restart', async () => {
    const current = await plugin()
    let finishRestart!: (handle: PluginWorkerHandle) => void
    const restarted = worker(['run'])
    const factory = vi
      .fn<PluginWorkerFactory>()
      .mockResolvedValueOnce(worker(['run']))
      .mockImplementationOnce(() => new Promise((resolve) => (finishRestart = resolve)))
    const subject = controller({ factory, verify: async () => undefined, isApproved: () => true })
    await subject.ensure(current)
    await writeFile(join(current.rootDir, 'main.mjs'), 'export default function activate() { 3 }')
    const reviewed = await hashPluginTree(current.rootDir)
    const updated = { ...current, consentContentHash: reviewed.ok ? reviewed.hash : null }

    const reconciling = subject.reconcile(
      new Map([[updated.pluginKey, buildPluginWorkerSpawnSpec(updated, [])]]),
      () => updated
    )
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    const disposing = subject.dispose()
    finishRestart(restarted)

    await reconciling
    await disposing
    expect(restarted.dispose).toHaveBeenCalledOnce()
    await expect(subject.ensure(updated)).rejects.toThrow('shut down')
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
