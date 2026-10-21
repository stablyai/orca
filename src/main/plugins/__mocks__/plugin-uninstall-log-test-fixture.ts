import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import type * as ChildProcess from 'node:child_process'
import { PluginContentVerifier } from '../plugin-content-integrity'
import { PluginService } from '../plugin-service'
import { registerPluginHandlers } from '../../ipc/plugins'
import { installPluginFromLocalPath, installBundledPlugin } from '../plugin-install'
import { installStagedPluginTree } from '../plugin-install-staging'
import { getUserPluginsDir } from '../plugin-discovery'
import { PluginWorkerController } from '../plugin-worker-controller'
import { UninstallWorkerPort } from '../plugin-uninstall-worker-fixture'
import type { PluginManifest } from '../../../shared/plugins/plugin-manifest'

const ports = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  fork: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      ports.handlers.set(name, handler),
    on() {}
  }
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  fork: (...args: unknown[]) => ports.fork(...args)
}))

const roots: string[] = []
const services: PluginService[] = []
export const uninstallWorkerPorts: UninstallWorkerPort[] = []

export function prepareUninstallFixture(): void {
  ports.handlers.clear()
  ports.fork.mockReset()
  ports.fork.mockImplementation(() => {
    const child = new UninstallWorkerPort()
    uninstallWorkerPorts.push(child)
    return child
  })
}

export async function resetUninstallFixtures(): Promise<void> {
  for (const service of services.splice(0)) {
    await service.dispose()
  }
  for (const child of uninstallWorkerPorts.splice(0)) {
    child.finishStdio()
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
}

export async function createUninstallFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-uninstall-'))
  roots.push(root)
  let settings: {
    pluginConsents: Record<string, string>
    disabledPlugins: string[]
    pluginSystemEnabled: boolean
    devPluginPaths: string[]
  } = {
    pluginConsents: {},
    disabledPlugins: [],
    pluginSystemEnabled: true,
    devPluginPaths: []
  }
  const listeners: ((patch: Partial<typeof settings>) => void)[] = []
  const store = {
    getSettings: () => settings,
    onSettingsChanged(listener: (patch: Partial<typeof settings>) => void) {
      listeners.push(listener)
      return () => {}
    },
    updateSettings(patch: Partial<typeof settings>) {
      settings = { ...settings, ...patch }
      for (const listener of listeners) {
        listener(patch)
      }
    }
  }
  const service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => settings.pluginSystemEnabled,
    getDisabledPlugins: () => settings.disabledPlugins,
    getPluginConsents: () => settings.pluginConsents,
    getDevPluginPaths: () => [],
    hostEntryPath: 'inert-worker-entry'
  })
  services.push(service)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The exercised removal IPC uses only these settings reads, writes and registration methods.
  registerPluginHandlers(store as never, service, null)
  await service.initialize()

  async function install(
    id: string,
    contributes: Partial<PluginManifest['contributes']> = {},
    official = false
  ) {
    const sourcePath = join(root, 'sources', id)
    await mkdir(sourcePath, { recursive: true })
    const manifest = {
      manifestVersion: 1,
      id,
      publisher: official ? 'stablyai' : 'memory-audit',
      name: id,
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      main: 'worker.js',
      contributes: { commands: [{ id: 'run', title: 'Run' }], ...contributes },
      capabilities: contributes.events ? [{ kind: 'events:subscribe' }] : []
    }
    await writeFile(join(sourcePath, 'orca-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(sourcePath, 'worker.js'), 'export default function () {}')
    if (contributes.panels) {
      await writeFile(join(sourcePath, 'panel.html'), '<p>Fixture panel</p>')
    }
    const result = official
      ? await installStagedPluginTree({
          pluginsDir: getUserPluginsDir(root),
          stagingDir: sourcePath,
          hostVersion: '1.4.0',
          source: { kind: 'git', url: 'https://github.com/stablyai/orca-plugins.git', ref: 'main' },
          resolvedCommit: '1'.repeat(40)
        })
      : await installPluginFromLocalPath({
          pluginsDir: getUserPluginsDir(root),
          sourcePath,
          hostVersion: '1.4.0'
        })
    if (!result.ok) {
      throw new Error(result.error)
    }
    settings.pluginConsents[result.pluginKey] = result.consentFingerprint
    await service.refresh()
    await service.invokeCommand(result.pluginKey, 'run')
    return result.pluginKey
  }
  return { root, service, store, install }
}

export async function removeThroughPluginIpc(pluginKey: string): Promise<unknown> {
  const handler = ports.handlers.get('plugins:remove')
  if (!handler) {
    throw new Error('Missing removal handler')
  }
  return handler({ sender: { id: 42 } }, { pluginKey })
}

export function latestUninstallWorker(): UninstallWorkerPort {
  const child = uninstallWorkerPorts.at(-1)
  if (!child) {
    throw new Error('No worker was created')
  }
  return child
}

export function latestPluginLog(service: PluginService, pluginKey: string) {
  const row = service.getLogs(pluginKey).at(-1)
  if (!row) {
    throw new Error('Expected a retained log row')
  }
  return row
}

export function uninstallGate() {
  let resolve: () => void = () => {
    throw new Error('Gate not initialized')
  }
  let reject: (reason: Error) => void = (_reason) => {
    throw new Error('Gate not initialized')
  }
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export function uninstallWorkerController(service: PluginService): PluginWorkerController {
  const inspected: object = service
  if (
    !('workerController' in inspected) ||
    !(inspected.workerController instanceof PluginWorkerController)
  ) {
    throw new Error('Unexpected controller port')
  }
  return inspected.workerController
}

function hasRefreshPort(target: unknown): target is {
  performRefresh: (...args: unknown[]) => unknown
} {
  return (
    typeof target === 'object' &&
    target !== null &&
    'performRefresh' in target &&
    typeof target.performRefresh === 'function'
  )
}

export function holdNextUninstallRefresh(service: PluginService) {
  const inspected: object = service
  if (!hasRefreshPort(inspected)) {
    throw new Error('Missing refresh port')
  }
  const method = inspected.performRefresh.bind(service)
  const entered = uninstallGate()
  const release = uninstallGate()
  const refresh = vi
    .spyOn(inspected, 'performRefresh')
    .mockImplementationOnce(async (...args: unknown[]) => {
      entered.resolve()
      await release.promise
      return method(...args)
    })
  return { entered, release, restore: () => refresh.mockRestore() }
}

export async function publishBundledUninstallSuccessor(root: string, id: string, key: string) {
  const sourcePath = join(root, 'sources', id)
  await writeFile(
    join(sourcePath, 'worker.js'),
    'export default function () { /* bundled revision */ }'
  )
  const result = await installBundledPlugin({
    pluginsDir: getUserPluginsDir(root),
    sourcePath,
    hostVersion: '1.4.0',
    expectedPluginKey: key
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result
}

export function uninstallContentVerifier(service: PluginService): PluginContentVerifier {
  const inspected: object = service
  if (
    !('contentVerifier' in inspected) ||
    !(inspected.contentVerifier instanceof PluginContentVerifier)
  ) {
    throw new Error('Unexpected verifier port')
  }
  return inspected.contentVerifier
}

export function requireInstalledPlugin(service: PluginService, key: string) {
  const plugin = service.findValidPlugin(key)
  if (!plugin) {
    throw new Error('Expected installed plugin')
  }
  return plugin
}
