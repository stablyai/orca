/**
 * The invoker's activation contract held against the real PluginService:
 * the first burst of calls a task surface makes at an idle plugin must spawn
 * one worker and all come back with data.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginService } from './plugin-service'
import type { PluginWorkerFactory } from './plugin-worker-manager'
import { invokeContributedTaskSource } from './plugin-task-source-invoker'

const pluginKey = 'orca-samples.demo'
const sourceId = 'demo-tasks'
const roots: string[] = []
const services: PluginService[] = []

const manifest = pluginManifestSchema.parse({
  manifestVersion: 1,
  id: 'demo',
  publisher: 'orca-samples',
  name: 'Demo',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  main: 'worker.js',
  contributes: {
    taskSources: [{ id: sourceId, title: 'Demo Tasks' }],
    commands: [],
    events: []
  },
  capabilities: []
})

function workerHandle(): PluginWorkerHandle {
  return {
    commands: [],
    taskSources: [sourceId],
    invokeCommand: vi.fn(async () => null),
    invokeTaskSource: vi.fn(async (_source: string, method: string) =>
      method === 'listScopes'
        ? { ok: true, data: [{ id: 'team-1', name: 'Team One' }] }
        : { ok: true, data: { items: [], nextCursor: null } }
    ),
    deliverEvent: vi.fn(),
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: vi.fn()
  }
}

async function harness(): Promise<{ service: PluginService; factory: ReturnType<typeof vi.fn> }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-task-source-activation-'))
  roots.push(root)
  await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'worker.js'), 'export default async function () {}')
  const factory = vi.fn<PluginWorkerFactory>(async () => {
    // Widens the window two independent activations would race in.
    await new Promise((resolve) => setTimeout(resolve, 10))
    return workerHandle()
  })
  const service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => [],
    getPluginConsents: () => ({ [pluginKey]: fingerprintPluginConsent(manifest) }),
    getDevPluginPaths: () => [root],
    workerFactory: factory
  })
  services.push(service)
  await service.initialize()
  return { service, factory }
}

function call(service: PluginService, method: string) {
  return invokeContributedTaskSource({
    resolveProxy: (key, source) => service.resolveTaskSourceProxy(key, source),
    activate: (key) => service.activateForTaskSource(key),
    pluginKey,
    sourceId,
    method,
    params: method === 'listScopes' ? {} : { scopeIds: [], search: null, cursor: null, limit: 50 }
  })
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('contributed task source activation sharing', () => {
  it('serves a concurrent listScopes and listItems from one worker spawn', async () => {
    const { service, factory } = await harness()

    const [scopes, items] = await Promise.all([
      call(service, 'listScopes'),
      call(service, 'listItems')
    ])

    expect(scopes).toMatchObject({ ok: true })
    expect(items).toMatchObject({ ok: true })
    expect(factory).toHaveBeenCalledOnce()
  })

  it('serves ten concurrent calls from one worker spawn', async () => {
    const { service, factory } = await harness()

    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        call(service, index % 2 === 0 ? 'listItems' : 'listScopes')
      )
    )

    expect(results.every((result) => result.ok)).toBe(true)
    expect(factory).toHaveBeenCalledOnce()
  })

  it('hands a second caller the attempt already in flight', async () => {
    const { service } = await harness()

    const first = service.activateForTaskSource(pluginKey)
    const second = service.activateForTaskSource(pluginKey)

    expect(second).toBe(first)
    await first
  })
})
