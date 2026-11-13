import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginService } from '../plugins/plugin-service'
import { getPluginsDataDir, getUserPluginsDir } from '../plugins/plugin-discovery'
import {
  installPluginFromLocalPath,
  readPluginLockfile
} from '../plugins/installation/plugin-install'

type IpcHandler = (event: unknown, args: unknown) => Promise<unknown>
const handlers = vi.hoisted(() => new Map<string, IpcHandler>())
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: IpcHandler) => handlers.set(name, handler), on() {} }
}))
vi.mock('../plugins/panels/guest-isolation/plugin-frame-guest-sessions', () => ({
  bindPluginFrameGuests() {},
  clearPluginFrameStorage: async () => {},
  preparePluginFrameGuest: async () => null
}))
const { registerPluginHandlers } = await import('./plugins')
const roots: string[] = []
const services: PluginService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.dispose()
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  handlers.clear()
})

async function fixture(development: boolean, pluginIds = ['demo']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-dev-unload-')))
  roots.push(root)
  const sourcePaths = pluginIds.map((id) => join(root, id))
  const sourcePath = sourcePaths[0]
  const userDataPath = join(root, 'profile')
  for (const [index, id] of pluginIds.entries()) {
    await mkdir(sourcePaths[index])
    await writeFile(
      join(sourcePaths[index], 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 2,
        id,
        name: id,
        version: '1.0.0',
        engines: { orca: '>=1.4.246' },
        execution: 'data'
      })
    )
  }
  await writeFile(join(sourcePath, 'source.txt'), 'source-kept')
  let settings = {
    devPluginPaths: development ? sourcePaths : [],
    pluginSystemEnabled: true,
    pluginConsents: {},
    disabledPlugins: []
  }
  const store = {
    getSettings: () => settings,
    updateSettings: (patch: Partial<typeof settings>) => {
      settings = { ...settings, ...patch }
    }
  }
  const service = new PluginService({
    userDataPath,
    hostVersion: '1.4.257',
    isPluginSystemEnabled: () => true,
    getDevPluginPaths: () => settings.devPluginPaths,
    getPluginConsents: () => settings.pluginConsents,
    getDisabledPlugins: () => settings.disabledPlugins
  })
  services.push(service)
  if (!development) {
    const installed = await installPluginFromLocalPath({
      pluginsDir: getUserPluginsDir(userDataPath),
      sourcePath,
      hostVersion: '1.4.257'
    })
    if (!installed.ok) {
      throw new Error(installed.error)
    }
  }
  await service.initialize()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this IPC uses only settings reads/writes; the service and filesystem remain real.
  registerPluginHandlers(store as never, service)
  const data = join(getPluginsDataDir(userDataPath), 'local.demo', 'storage.json')
  await mkdir(join(data, '..'), { recursive: true })
  await writeFile(data, '{"remember":"keep"}')
  const unload = (pluginKey = 'local.demo') => {
    const handler = handlers.get('plugins:unloadDevFolder')
    if (!handler) {
      throw new Error('Missing development unload IPC')
    }
    return handler(undefined, { pluginKey })
  }
  return { sourcePath, userDataPath, service, store, data, unload }
}

it('unloads a development entry without deleting its source or saved data', async () => {
  const { sourcePath, service, store, data, unload } = await fixture(true)
  await expect(unload()).resolves.toEqual([])
  expect(store.getSettings().devPluginPaths).toEqual([])
  expect(service.getDiscovered()).toEqual([])
  expect(await readFile(join(sourcePath, 'source.txt'), 'utf8')).toBe('source-kept')
  expect(await readFile(data, 'utf8')).toBe('{"remember":"keep"}')
})

it('refuses a stale development removal targeting an installed plugin', async () => {
  const { sourcePath, userDataPath, data, unload } = await fixture(false)
  await expect(unload()).rejects.toThrow('development plugin')
  expect(
    (await readPluginLockfile(getUserPluginsDir(userDataPath))).plugins['local.demo']
  ).toBeDefined()
  expect(await readFile(join(sourcePath, 'source.txt'), 'utf8')).toBe('source-kept')
  expect(await readFile(data, 'utf8')).toBe('{"remember":"keep"}')
})

it('keeps both development folders unloaded when removal requests overlap', async () => {
  const { store, unload } = await fixture(true, ['demo', 'another'])
  await expect(Promise.all([unload('local.demo'), unload('local.another')])).resolves.toEqual([
    [],
    []
  ])
  expect(store.getSettings().devPluginPaths).toEqual([])
})
