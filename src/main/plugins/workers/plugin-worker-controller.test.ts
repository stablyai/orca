import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { hashPluginTree } from '../plugin-content-hash'
import { PluginContentVerifier } from '../plugin-content-integrity'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginWorkerController } from './plugin-worker-controller'
import type { PluginWorkerFactory } from './plugin-worker-manager'
import type { PluginLogBuffer } from '../plugin-log-buffer'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function plugin(): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-worker-controller-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'main.mjs'), 'export default function activate() {}')
  return {
    pluginKey: 'samples.demo',
    rootDir,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'samples',
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
    taskSources: [],
    invokeTaskSource: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    requestFromPanel: vi.fn(),
    runHook: vi.fn(),
    notifyDataChanged: vi.fn(),
    lastActivityAt: () => 1_000,
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: vi.fn()
  }
}

function controller(options: {
  factory: PluginWorkerFactory
  verify?: () => Promise<void>
  isApproved: () => boolean
  isApprovalKept?: () => boolean
  logs?: PluginLogBuffer
}): PluginWorkerController {
  const contentVerifier = new PluginContentVerifier()
  if (options.verify) {
    contentVerifier.verify = options.verify
    contentVerifier.verifyNow = options.verify
  }
  return new PluginWorkerController({
    entryPath: '/host-entry.js',
    workerFactory: options.factory,
    contentVerifier,
    capabilities: () => (options.isApproved() ? [] : null),
    isCurrentApproved: () => options.isApproved(),
    isApprovalKept: options.isApprovalKept,
    executeHostCall: vi.fn(async () => ({ ok: true as const, value: null })),
    log: (key) => options.logs?.capture(key) ?? vi.fn(),
    onStateChanged: vi.fn()
  })
}

describe('PluginWorkerController activation authority', () => {
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

  it('starts a dev worker after typings land in .orca/ past the reviewed dev-folder hash', async () => {
    const subjectPlugin = await plugin()
    const reviewed = await hashPluginTree(subjectPlugin.rootDir, { devFolder: true })
    if (!reviewed.ok) {
      throw new Error(reviewed.error)
    }
    await mkdir(join(subjectPlugin.rootDir, '.orca', 'types'), { recursive: true })
    await writeFile(join(subjectPlugin.rootDir, '.orca', 'types', 'orca.d.ts'), 'export {}')
    const factory = vi.fn<PluginWorkerFactory>().mockResolvedValue(worker(['run']))
    const subject = controller({ factory, isApproved: () => true })

    await subject.ensure({ ...subjectPlugin, consentContentHash: reviewed.hash })

    expect(factory).toHaveBeenCalledOnce()
    await subject.dispose()
  })
})
