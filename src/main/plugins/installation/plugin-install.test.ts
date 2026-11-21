import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installPluginFromLocalPath,
  readPluginLockfile,
  removeInstalledPlugin
} from './plugin-install'
import { PluginService } from '../plugin-service'
import { listPluginsForClients } from '../discovery/plugin-client-list'
import { readPluginCurrentPointer } from './plugin-current-pointer'

const roots: string[] = []

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function writePluginSource(
  root: string,
  options: { id?: string; panelEntry?: string; includePanel?: boolean } = {}
): Promise<void> {
  const panelEntry = options.panelEntry ?? 'panel.html'
  await writeFile(
    join(root, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: options.id ?? 'demo',
      publisher: 'samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {
        panels: [{ id: 'panel', title: 'Panel', entry: panelEntry }],
        commands: [],
        events: []
      },
      capabilities: []
    })
  )
  if (options.includePanel !== false) {
    await writeFile(join(root, panelEntry), '<h1>Panel</h1>')
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('installPluginFromLocalPath', () => {
  it('lists installed plugins in installation order even when IDs sort differently', async () => {
    const userDataPath = await tempRoot('orca-plugin-order-')
    const firstSource = await tempRoot('orca-plugin-first-')
    const secondSource = await tempRoot('orca-plugin-second-')
    await writePluginSource(firstSource, { id: 'z-first' })
    await writePluginSource(secondSource, { id: 'a-second' })
    const pluginsDir = join(userDataPath, 'plugins')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const first = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath: firstSource,
      hostVersion: '1.4.0'
    })
    clock.mockReturnValue(2000)
    const second = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath: secondSource,
      hostVersion: '1.4.0'
    })
    expect(first.ok && second.ok).toBe(true)
    clock.mockRestore()
    const service = new PluginService({
      userDataPath,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => false,
      getDisabledPlugins: () => [],
      getPluginConsents: () => ({}),
      getDevPluginPaths: () => []
    })
    expect((await listPluginsForClients(service)).map((entry) => entry.pluginKey)).toEqual([
      'samples.z-first',
      'samples.a-second'
    ])
  })

  it.each(['equal', 'missing'] as const)(
    'orders plugin IDs by code point when install times are %s',
    async (times) => {
      const userDataPath = await tempRoot('orca-plugin-tie-')
      const zSource = await tempRoot('orca-plugin-z-')
      const aaSource = await tempRoot('orca-plugin-aa-')
      await writePluginSource(zSource, { id: 'z' })
      await writePluginSource(aaSource, { id: 'aa' })
      const pluginsDir = join(userDataPath, 'plugins')
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
      if (times === 'equal') {
        expect(
          (
            await installPluginFromLocalPath({
              pluginsDir,
              sourcePath: zSource,
              hostVersion: '1.4.0'
            })
          ).ok
        ).toBe(true)
        expect(
          (
            await installPluginFromLocalPath({
              pluginsDir,
              sourcePath: aaSource,
              hostVersion: '1.4.0'
            })
          ).ok
        ).toBe(true)
      }
      clock.mockRestore()
      const service = new PluginService({
        userDataPath,
        hostVersion: '1.4.0',
        isPluginSystemEnabled: () => false,
        getDisabledPlugins: () => [],
        getPluginConsents: () => ({}),
        getDevPluginPaths: () => (times === 'missing' ? [zSource, aaSource] : [])
      })
      const original = String.prototype.localeCompare
      const danish = new Intl.Collator('da-DK')
      vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
        this: string,
        other
      ) {
        const current = String(this)
        if (
          (current === 'samples.aa' || current === 'samples.z') &&
          (other === 'samples.aa' || other === 'samples.z')
        ) {
          return danish.compare(current, other)
        }
        return original.call(current, other)
      })
      expect((await listPluginsForClients(service)).map((entry) => entry.pluginKey)).toEqual([
        'samples.aa',
        'samples.z'
      ])
    }
  )

  it('restores the previous current pointer when lockfile publication fails', async () => {
    const sourcePath = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(sourcePath)
    const first = await installPluginFromLocalPath({ pluginsDir, sourcePath, hostVersion: '1.4.0' })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    await writeFile(join(sourcePath, 'panel.html'), '<h1>Updated</h1>')
    await rm(join(pluginsDir, 'plugins.lock.json'))
    await mkdir(join(pluginsDir, 'plugins.lock.json'))

    const failed = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath,
      hostVersion: '1.4.0'
    })

    expect(failed).toMatchObject({ ok: false })
    await expect(readPluginCurrentPointer(join(pluginsDir, first.pluginKey))).resolves.toBe(
      first.contentHash
    )
  })

  it('preserves legacy lock provenance during a same-content reinstall', async () => {
    const firstSource = await tempRoot('orca-plugin-source-')
    const secondSource = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(firstSource)
    await writePluginSource(secondSource)
    const first = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath: firstSource,
      hostVersion: '1.4.0'
    })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    await rm(join(pluginsDir, first.pluginKey, '.install-provenance', `${first.contentHash}.json`))
    const reinstalled = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath: secondSource,
      hostVersion: '1.4.0'
    })
    expect(reinstalled).toMatchObject({ ok: true })

    // Backfilled provenance must retain the accepted legacy source through same-byte reinstall.
    await rm(join(pluginsDir, 'plugins.lock.json'))
    const recovered = await readPluginLockfile(pluginsDir)
    expect(recovered.plugins[first.pluginKey]?.source).toEqual({
      kind: 'local-path',
      path: firstSource
    })
  })

  it('serializes concurrent installs so lockfile entries are not lost', async () => {
    const firstSource = await tempRoot('orca-plugin-source-')
    const secondSource = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(firstSource, { id: 'first' })
    await writePluginSource(secondSource, { id: 'second' })

    const results = await Promise.all([
      installPluginFromLocalPath({ pluginsDir, sourcePath: firstSource, hostVersion: '1.4.0' }),
      installPluginFromLocalPath({ pluginsDir, sourcePath: secondSource, hostVersion: '1.4.0' })
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    const lock = JSON.parse(await readFile(join(pluginsDir, 'plugins.lock.json'), 'utf8')) as {
      plugins: Record<string, unknown>
    }
    expect(Object.keys(lock.plugins).sort()).toEqual(['samples.first', 'samples.second'])
  })
})

describe('removeInstalledPlugin', () => {
  it('rejects a resolved uninstall target outside its root', async () => {
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    const pluginsDataDir = await tempRoot('orca-plugin-data-')
    const outside = await tempRoot('orca-plugin-outside-')
    const marker = join(outside, 'keep.txt')
    await writeFile(marker, 'keep')
    await symlink(
      outside,
      join(pluginsDir, 'samples.demo'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      removeInstalledPlugin({
        pluginsDir,
        pluginsDataDir,
        pluginKey: 'samples.demo'
      })
    ).rejects.toThrow('outside')
    await expect(readFile(marker, 'utf8')).resolves.toBe('keep')
  })

  it('runs beforeRemove before deleting files and keeps them when it fails', async () => {
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    const pluginsDataDir = await tempRoot('orca-plugin-data-')
    const key = 'samples.demo'
    await mkdir(join(pluginsDir, key))
    await writeFile(join(pluginsDir, key, 'content'), 'installed')

    await expect(
      removeInstalledPlugin({
        pluginsDir,
        pluginsDataDir,
        pluginKey: key,
        beforeRemove: () => {
          throw new Error('consent store unavailable')
        }
      })
    ).rejects.toThrow('consent store unavailable')
    await expect(readFile(join(pluginsDir, key, 'content'), 'utf8')).resolves.toBe('installed')

    const observed: string[] = []
    await removeInstalledPlugin({
      pluginsDir,
      pluginsDataDir,
      pluginKey: key,
      beforeRemove: async () => {
        observed.push(await readFile(join(pluginsDir, key, 'content'), 'utf8'))
      }
    })
    expect(observed).toEqual(['installed'])
    await expect(readFile(join(pluginsDir, key, 'content'))).rejects.toThrow()
  })
})
