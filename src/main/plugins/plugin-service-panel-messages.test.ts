import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginHostCallOutcome } from '../../shared/plugins/frames/plugin-protocol'
import { devFolderConsentIdentity } from './plugin-discovery'
import { PluginService } from './plugin-service'
import type { PluginWorkerHandle } from './workers/plugin-host-process'
import type { PluginWorkerFactory } from './workers/plugin-worker-manager'

const roots: string[] = []
const services: PluginService[] = []

type Fixture = { id: string; main?: string }

function manifestFor({ id, main }: Fixture) {
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id,
    publisher: 'samples',
    name: id,
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    ...(main ? { main } : {}),
    contributes: {
      panels: [{ id: 'player', title: 'Player', entry: 'panel.html' }],
      commands: [],
      events: []
    },
    capabilities: []
  })
}

async function pluginRoot(fixture: Fixture): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-panel-messages-'))
  roots.push(root)
  await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(manifestFor(fixture)))
  await writeFile(join(root, 'worker.mjs'), 'export default function activate() {}')
  await writeFile(join(root, 'panel.html'), '<h1>Player</h1>')
  return root
}

function fakeWorker(pluginId: string, generation: number) {
  const exitCallbacks: ((code: number | null) => void)[] = []
  const deliverPanelMessage = vi.fn(
    async (panelId: string, message: unknown): Promise<PluginHostCallOutcome> => ({
      ok: true,
      value: { pluginId, generation, panelId, message }
    })
  )
  const handle: PluginWorkerHandle = {
    commands: [],
    invokeCommand: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    deliverPanelMessage,
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: (callback) => exitCallbacks.push(callback)
  }
  return {
    handle,
    deliverPanelMessage,
    exit: (code: number) => exitCallbacks.forEach((cb) => cb(code))
  }
}

async function createHarness(fixtures: Fixture[]) {
  const dirs = await Promise.all(fixtures.map(pluginRoot))
  const consents = Object.fromEntries(
    await Promise.all(
      fixtures.map(async (fixture, index) => [
        `samples.${fixture.id}`,
        fingerprintPluginConsent(manifestFor(fixture), await devFolderConsentIdentity(dirs[index]!))
      ])
    )
  )
  const workers: ReturnType<typeof fakeWorker>[] = []
  const generations = new Map<string, number>()
  const factory = vi.fn<PluginWorkerFactory>(async ({ pluginId }) => {
    const generation = (generations.get(pluginId) ?? 0) + 1
    generations.set(pluginId, generation)
    const worker = fakeWorker(pluginId, generation)
    workers.push(worker)
    return worker.handle
  })
  const service = new PluginService({
    userDataPath: dirs[0]!,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => [],
    getPluginConsents: () => consents,
    getDevPluginPaths: () => dirs,
    workerFactory: factory
  })
  services.push(service)
  await service.initialize()
  const post = async (pluginId: string, params: unknown) => {
    const entry = await service.panels.open('owner', `samples.${pluginId}`, 'player')
    return service.panels.execute('owner', {
      sessionToken: entry!.sessionToken,
      action: 'panel.postMessage',
      params
    })
  }
  return { service, factory, workers, post }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('panel messages through PluginService', () => {
  it('reaches only the worker of the panel owner, whatever ids the frame puts in the message', async () => {
    const { factory, workers, post } = await createHarness([
      { id: 'alpha', main: 'worker.mjs' },
      { id: 'beta', main: 'worker.mjs' }
    ])
    const forged = { pluginKey: 'samples.beta', pluginId: 'samples.beta', panelId: 'player' }

    await expect(post('alpha', forged)).resolves.toEqual({
      ok: true,
      value: { pluginId: 'samples.alpha', generation: 1, panelId: 'player', message: forged }
    })

    expect(factory).toHaveBeenCalledOnce()
    expect(workers).toHaveLength(1)
    expect(workers[0]!.deliverPanelMessage).toHaveBeenCalledWith('player', forged)
  })

  it('answers unknown_method and starts nothing for a panel plugin without a worker', async () => {
    const { factory, post } = await createHarness([{ id: 'static' }])

    await expect(post('static', { type: 'getState' })).resolves.toMatchObject({
      ok: false,
      code: 'unknown_method'
    })
    expect(factory).not.toHaveBeenCalled()
  })

  it('starts the worker on the first message and again after it was stopped', async () => {
    const { service, factory, post } = await createHarness([{ id: 'alpha', main: 'worker.mjs' }])
    expect(factory).not.toHaveBeenCalled()

    await expect(post('alpha', 1)).resolves.toMatchObject({ ok: true, value: { generation: 1 } })
    await expect(post('alpha', 2)).resolves.toMatchObject({ ok: true, value: { generation: 1 } })
    expect(factory).toHaveBeenCalledOnce()

    await service.deactivatePlugin('samples.alpha')

    await expect(post('alpha', 3)).resolves.toMatchObject({
      ok: true,
      value: { generation: 2, message: 3 }
    })
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('joins the restart of a crashed worker instead of failing the panel', async () => {
    const { factory, workers, post } = await createHarness([{ id: 'alpha', main: 'worker.mjs' }])
    await post('alpha', 1)
    vi.useFakeTimers()

    workers[0]!.exit(1)
    const answered = post('alpha', 2)
    await vi.advanceTimersByTimeAsync(500)

    await expect(answered).resolves.toMatchObject({ ok: true, value: { generation: 2 } })
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
