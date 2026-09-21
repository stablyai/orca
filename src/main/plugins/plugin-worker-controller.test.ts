import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPluginExtensionRegistry,
  PLUGIN_TASK_SOURCE_EXTENSION_POINT,
  type PluginExtensionRegistry
} from '../../shared/plugins/plugin-extension-registry'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { PluginContentVerifier } from './plugin-content-integrity'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerHandle } from './plugin-host-process'
import {
  PluginWorkerController,
  type PluginWorkerControllerOptions
} from './plugin-worker-controller'
import type { PluginWorkerFactory } from './plugin-worker-manager'
import { PluginLogBuffer } from './plugin-log-buffer'
import { invokeContributedTaskSource } from './plugin-task-source-invoker'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function plugin(taskSourceIds: string[] = []): Promise<ValidDiscoveredPlugin> {
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
        events: [],
        taskSources: taskSourceIds.map((id) => ({ id, title: `Title ${id}` }))
      },
      capabilities: []
    }),
    consentFingerprint: 'sha256-current',
    contentHash: null,
    isDev: true
  }
}

function worker(
  commands: string[],
  taskSources: string[] = []
): PluginWorkerHandle & { dispose: ReturnType<typeof vi.fn> } {
  return {
    commands,
    taskSources,
    invokeCommand: vi.fn(async () => null),
    invokeTaskSource: vi.fn(async () => null),
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
  logs?: PluginLogBuffer
  registry?: PluginExtensionRegistry
  invokeTaskSource?: PluginWorkerControllerOptions['invokeTaskSource']
}): PluginWorkerController {
  return new PluginWorkerController({
    entryPath: '/host-entry.js',
    workerFactory: options.factory,
    registry: options.registry ?? createPluginExtensionRegistry(),
    contentVerifier: { verify: options.verify } as unknown as PluginContentVerifier,
    capabilities: () => (options.isApproved() ? [] : null),
    isCurrentApproved: () => options.isApproved(),
    invokeCommand: vi.fn(async () => null),
    invokeTaskSource: options.invokeTaskSource ?? vi.fn(async () => null),
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

    await expect(activation).rejects.toThrow('disabled during activation')
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

  it('rejects and stops workers that register undeclared task sources', async () => {
    const subjectPlugin = await plugin(['boards'])
    const startedWorker = worker(['run'], ['boards', 'smuggled'])
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>().mockResolvedValue(startedWorker),
      verify: async () => undefined,
      isApproved: () => true
    })

    await expect(subject.ensure(subjectPlugin)).rejects.toThrow(
      'registered undeclared task source smuggled'
    )
    expect(startedWorker.dispose).toHaveBeenCalledOnce()
    await subject.dispose()
  })

  it('activates a worker whose task sources are all declared', async () => {
    const subjectPlugin = await plugin(['boards'])
    const startedWorker = worker(['run'], ['boards'])
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>().mockResolvedValue(startedWorker),
      verify: async () => undefined,
      isApproved: () => true
    })

    await expect(subject.ensure(subjectPlugin)).resolves.toBe(startedWorker)
    expect(startedWorker.dispose).not.toHaveBeenCalled()
    expect(subject.activationError(subjectPlugin.pluginKey)).toBeNull()
    await subject.dispose()
  })
})

describe('PluginWorkerController task source extension point', () => {
  it('registers one proxy per source, addressable by plugin and provider id', async () => {
    const subjectPlugin = await plugin(['boards', 'issues'])
    const registry = createPluginExtensionRegistry()
    const invokeTaskSource = vi.fn(async () => ({ ok: true, data: null }))
    const subject = controller({
      factory: vi
        .fn<PluginWorkerFactory>()
        .mockResolvedValue(worker(['run'], ['boards', 'issues'])),
      verify: async () => undefined,
      isApproved: () => true,
      registry,
      invokeTaskSource
    })
    await subject.ensure(subjectPlugin)

    const issues = registry.resolve(
      PLUGIN_TASK_SOURCE_EXTENSION_POINT,
      subjectPlugin.pluginKey,
      'issues'
    )
    await issues?.call('listItems', { limit: 1 })

    expect(issues?.sourceId).toBe('issues')
    expect(invokeTaskSource).toHaveBeenCalledWith(subjectPlugin.pluginKey, 'issues', 'listItems', {
      limit: 1
    })
    await subject.dispose()
  })

  it.each([
    ['listItems', { items: 'not-an-array' }],
    ['getItem', { items: [], nextCursor: null }]
  ] as const)('answers unavailable when the worker violates the %s schema', async (method, data) => {
    const registry = createPluginExtensionRegistry()
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>().mockResolvedValue(worker(['run'], ['boards'])),
      verify: async () => undefined,
      isApproved: () => true,
      registry,
      invokeTaskSource: vi.fn(async () => ({ ok: true, data }))
    })
    await subject.ensure(await plugin(['boards']))

    const proxy = registry.resolve(PLUGIN_TASK_SOURCE_EXTENSION_POINT, 'orca-samples.demo', 'boards')

    await expect(proxy?.call(method, {})).resolves.toMatchObject({
      ok: false,
      code: 'unavailable'
    })
    await subject.dispose()
  })

  it('scrubs a worker rejection instead of letting the stack reach the caller', async () => {
    const registry = createPluginExtensionRegistry()
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>().mockResolvedValue(worker(['run'], ['boards'])),
      verify: async () => undefined,
      isApproved: () => true,
      registry,
      invokeTaskSource: vi.fn(async () => {
        throw new Error('at handler (/plugins/acme.boards/main.js:42:9)')
      })
    })
    await subject.ensure(await plugin(['boards']))

    const proxy = registry.resolve(PLUGIN_TASK_SOURCE_EXTENSION_POINT, 'orca-samples.demo', 'boards')
    const result = await proxy?.call('listItems', {})

    expect(result).toEqual({
      ok: false,
      code: 'unavailable',
      message: 'task source boards is unavailable'
    })
    expect(JSON.stringify(result)).not.toContain('main.js')
    await subject.dispose()
  })

  it('resolves the validated envelope when the worker honours the schema', async () => {
    const registry = createPluginExtensionRegistry()
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>().mockResolvedValue(worker(['run'], ['boards'])),
      verify: async () => undefined,
      isApproved: () => true,
      registry,
      invokeTaskSource: vi.fn(async () => ({
        ok: true,
        data: { items: [], nextCursor: null }
      }))
    })
    await subject.ensure(await plugin(['boards']))

    const proxy = registry.resolve(PLUGIN_TASK_SOURCE_EXTENSION_POINT, 'orca-samples.demo', 'boards')

    await expect(proxy?.call('listItems', {})).resolves.toEqual({
      ok: true,
      data: { items: [], nextCursor: null }
    })
    await subject.dispose()
  })

  it('activates an idle plugin worker on the first task source call and returns its data', async () => {
    const subjectPlugin = await plugin(['boards'])
    const registry = createPluginExtensionRegistry()
    const factory = vi.fn<PluginWorkerFactory>().mockResolvedValue(worker(['run'], ['boards']))
    const subject = controller({
      factory,
      verify: async () => undefined,
      isApproved: () => true,
      registry,
      invokeTaskSource: vi.fn(async () => ({ ok: true, data: { items: [], nextCursor: null } }))
    })

    const result = await invokeContributedTaskSource({
      resolveProxy: (pluginKey, sourceId) =>
        registry.resolve(PLUGIN_TASK_SOURCE_EXTENSION_POINT, pluginKey, sourceId),
      activate: () => subject.ensure(subjectPlugin).then(() => undefined),
      pluginKey: subjectPlugin.pluginKey,
      sourceId: 'boards',
      method: 'listItems',
      params: { scopeIds: [], search: null, cursor: null, limit: 50 }
    })

    expect(factory).toHaveBeenCalledOnce()
    expect(result).toEqual({ ok: true, data: { items: [], nextCursor: null } })
    await subject.dispose()
  })

  it('does not re-activate a plugin whose worker is already active', async () => {
    const subjectPlugin = await plugin(['boards'])
    const registry = createPluginExtensionRegistry()
    const factory = vi.fn<PluginWorkerFactory>().mockResolvedValue(worker(['run'], ['boards']))
    const subject = controller({
      factory,
      verify: async () => undefined,
      isApproved: () => true,
      registry,
      invokeTaskSource: vi.fn(async () => ({ ok: true, data: { items: [], nextCursor: null } }))
    })
    await subject.ensure(subjectPlugin)
    const activate = vi.fn(() => subject.ensure(subjectPlugin).then(() => undefined))

    await invokeContributedTaskSource({
      resolveProxy: (pluginKey, sourceId) =>
        registry.resolve(PLUGIN_TASK_SOURCE_EXTENSION_POINT, pluginKey, sourceId),
      activate,
      pluginKey: subjectPlugin.pluginKey,
      sourceId: 'boards',
      method: 'listItems',
      params: {}
    })

    expect(activate).not.toHaveBeenCalled()
    expect(factory).toHaveBeenCalledOnce()
    await subject.dispose()
  })

  it('maps a failed activation (plugin no longer approved) to unavailable without rejecting or leaking it', async () => {
    const subjectPlugin = await plugin(['boards'])
    const registry = createPluginExtensionRegistry()
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>(),
      verify: async () => undefined,
      isApproved: () => false,
      registry
    })

    const result = await invokeContributedTaskSource({
      resolveProxy: (pluginKey, sourceId) =>
        registry.resolve(PLUGIN_TASK_SOURCE_EXTENSION_POINT, pluginKey, sourceId),
      activate: () => subject.ensure(subjectPlugin).then(() => undefined),
      pluginKey: subjectPlugin.pluginKey,
      sourceId: 'boards',
      method: 'listItems',
      params: {}
    })

    expect(result).toEqual({
      ok: false,
      code: 'unavailable',
      message: 'task source boards is not registered'
    })
    expect(JSON.stringify(result)).not.toContain('no longer approved')
    await subject.dispose()
  })

  it('drops the proxies when the plugin is deactivated', async () => {
    const subjectPlugin = await plugin(['boards'])
    const registry = createPluginExtensionRegistry()
    const subject = controller({
      factory: vi.fn<PluginWorkerFactory>().mockResolvedValue(worker(['run'], ['boards'])),
      verify: async () => undefined,
      isApproved: () => true,
      registry
    })
    await subject.ensure(subjectPlugin)

    await subject.deactivate(subjectPlugin.pluginKey)

    expect(registry.resolveAll(PLUGIN_TASK_SOURCE_EXTENSION_POINT)).toEqual([])
    await subject.dispose()
  })
})
