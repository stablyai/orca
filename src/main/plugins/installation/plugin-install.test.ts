import { existsSync } from 'node:fs'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installPluginFromLocalPath,
  readPluginLockfile,
  removeInstalledPlugin
} from './plugin-install'
import { readPluginCurrentPointer } from './plugin-current-pointer'
import { installStagedPluginTree } from './plugin-install-staging'
import { getRequiredTeamPlugins } from './plugin-team-install-policy'
import { PluginService } from '../plugin-service'
import { createDefaultLocalOrcaProfile } from '../../../shared/orca-profiles/orca-profiles'
import { initializeActiveTeamProfile } from '../../orca-profiles/cloud-auth/active-team-capabilities'

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
    const lock: { plugins: Record<string, unknown> } = JSON.parse(
      await readFile(join(pluginsDir, 'plugins.lock.json'), 'utf8')
    )
    expect(Object.keys(lock.plugins).sort()).toEqual(['samples.first', 'samples.second'])
  })

  it('copies a plugin reached through a linked source directory as a real directory without .git', async () => {
    const parent = await tempRoot('orca-plugin-linked-')
    const realSource = join(parent, 'real-source')
    const linkedSource = join(parent, 'linked-source')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await mkdir(realSource)
    await writePluginSource(realSource)
    await mkdir(join(realSource, '.git'))
    await writeFile(join(realSource, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await symlink(realSource, linkedSource, process.platform === 'win32' ? 'junction' : 'dir')

    const result = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath: linkedSource,
      hostVersion: '1.4.0'
    })

    expect(result).toMatchObject({ ok: true, pluginKey: 'samples.demo' })
    if (!result.ok) {
      return
    }
    const installedDir = join(pluginsDir, result.pluginKey, result.contentHash)
    expect((await lstat(installedDir)).isDirectory()).toBe(true)
    await expect(readFile(join(installedDir, 'panel.html'), 'utf8')).resolves.toBe('<h1>Panel</h1>')
    expect(existsSync(join(installedDir, '.git'))).toBe(false)
  })
})

describe('removeInstalledPlugin', () => {
  it('keeps the disabled state and allows removal when the installed catalog fails the team requirement', async () => {
    const userDataPath = await tempRoot('orca-required-plugin-')
    const stagingDir = await tempRoot('orca-required-plugin-source-')
    const pluginsDir = join(userDataPath, 'plugins')
    const pluginKey = 'samples.demo'
    const requiredCatalog = {
      kind: 'git',
      url: 'https://git.example.test/acme/catalog.git',
      ref: 'main'
    } as const
    const oldCatalog = { ...requiredCatalog, url: 'https://git.example.test/other/catalog.git' }
    const pluginSource = { url: 'https://git.example.test/samples/demo.git', ref: 'main' }
    const install = (catalog: typeof pluginSource) =>
      installStagedPluginTree({
        pluginsDir,
        stagingDir,
        hostVersion: '1.4.0',
        source: {
          kind: 'marketplace',
          marketplace: { ...catalog, resolvedCommit: 'a'.repeat(40) },
          plugin: pluginSource
        },
        resolvedCommit: 'b'.repeat(40),
        identity: { pluginKey }
      })
    await writePluginSource(stagingDir)
    const first = await install(oldCatalog)
    if (!first.ok) {
      throw new Error(first.error)
    }

    const cloud = {
      userId: 'member',
      cloudProfileId: 'member-profile',
      email: 'member@example.test',
      linkedAt: 1
    }
    const localProfile = createDefaultLocalOrcaProfile(1)
    initializeActiveTeamProfile(userDataPath, { ...localProfile, cloud })({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 2,
      identity: cloud,
      capabilities: {
        refreshedAt: 1,
        flags: { team_settings: true },
        teamPolicy: {
          orgIds: ['acme'],
          internalCatalogs: [requiredCatalog],
          requiredPlugins: [pluginKey],
          requiredPluginRules: [{ pluginKey, catalog: requiredCatalog, version: '^1.0.0' }]
        }
      }
    })

    const service = new PluginService({
      userDataPath,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => [pluginKey],
      getRequiredPlugins: getRequiredTeamPlugins,
      getPluginConsents: () => ({ [pluginKey]: first.consentFingerprint }),
      getDevPluginPaths: () => []
    })
    const remove = () =>
      removeInstalledPlugin({
        pluginsDir,
        pluginsDataDir: join(userDataPath, 'plugins-data'),
        pluginKey
      })
    try {
      await service.initialize()
      expect(service.findValidPlugin(pluginKey)).not.toBeNull()
      expect(service.findApprovedPlugin(pluginKey)).toBeNull()
      await remove()
      expect(await readPluginLockfile(pluginsDir)).toEqual({ version: 1, plugins: {} })

      expect(await install(requiredCatalog)).toMatchObject({ ok: true })
      await service.refresh()
      expect(service.findApprovedPlugin(pluginKey)).not.toBeNull()
      await expect(remove()).rejects.toThrow('required by your team')
    } finally {
      await service.dispose()
      initializeActiveTeamProfile(userDataPath, localProfile)(undefined)
    }
  })

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
