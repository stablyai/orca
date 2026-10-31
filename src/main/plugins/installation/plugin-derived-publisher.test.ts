import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installPluginFromGit,
  installPluginFromLocalPath,
  readPluginLockfile
} from './plugin-install'
import { serveRepositoriesOverTestSsh } from '../__mocks__/plugin-git-ssh-remote-fixture'
import { installStagedPluginTree } from './plugin-install-staging'
import { discoverPlugins, isInvalidDiscoveredPlugin } from '../plugin-discovery'
import { PLUGIN_DERIVED_PUBLISHER_SINCE } from '../../../shared/plugins/manifest/plugin-schema-field-docs'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const HOST = PLUGIN_DERIVED_PUBLISHER_SINCE

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function writeThemePlugin(root: string, publisher?: string): Promise<void> {
  await writeFile(
    join(root, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'data',
      id: 'dusk',
      ...(publisher ? { publisher } : {}),
      name: 'Dusk',
      version: '1.0.0',
      engines: { orca: `>=${HOST}` },
      contributes: { terminalThemes: [{ id: 'dusk', title: 'Dusk', path: 'dusk.json' }] }
    })
  )
  await writeFile(
    join(root, 'dusk.json'),
    JSON.stringify({ background: '#101010', foreground: '#f0f0f0' })
  )
}

async function commitRepository(root: string): Promise<void> {
  const git = (...args: string[]) => execFileAsync('git', args, { cwd: root })
  await git('init', '--quiet')
  await git('config', 'user.email', 'plugins@example.invalid')
  await git('config', 'user.name', 'Plugin Test')
  await git('add', '.')
  await git('commit', '--quiet', '-m', 'fixture')
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('derived plugin publishers', () => {
  it('names a Git URL install after the URL owner, ignoring the manifest publisher', async () => {
    const source = await tempRoot('orca-derived-git-')
    const pluginsDir = await tempRoot('orca-derived-installs-')
    await writeThemePlugin(source, 'brand-name')
    await commitRepository(source)
    await serveRepositoriesOverTestSsh(await tempRoot('orca-derived-ssh-'), {
      '/Acme/dusk.git': source
    })

    const result = await installPluginFromGit({
      pluginsDir,
      url: 'ssh://git@plugin.test/Acme/dusk.git',
      ref: '',
      hostVersion: HOST
    })

    expect(result).toMatchObject({ ok: true, pluginKey: 'acme.dusk' })
  })

  it('keeps the key of an install made before publishers were derived', async () => {
    const source = await tempRoot('orca-derived-git-')
    const pluginsDir = await tempRoot('orca-derived-installs-')
    await writeThemePlugin(source, 'brand-name')
    await commitRepository(source)
    await serveRepositoriesOverTestSsh(await tempRoot('orca-derived-ssh-'), {
      '/acme/dusk.git': source
    })
    const url = 'ssh://git@plugin.test/acme/dusk.git'
    // Why staged directly: it records `brand-name.dusk` from a Git source, as older Orca did.
    const legacy = await installStagedPluginTree({
      pluginsDir,
      stagingDir: source,
      hostVersion: HOST,
      source: { kind: 'git', url, ref: '' },
      resolvedCommit: null,
      identity: { publisher: 'brand-name' }
    })
    expect(legacy).toMatchObject({ ok: true, pluginKey: 'brand-name.dusk' })

    const result = await installPluginFromGit({ pluginsDir, url, ref: '', hostVersion: HOST })

    expect(result).toMatchObject({ ok: true, pluginKey: 'brand-name.dusk' })
    expect(Object.keys((await readPluginLockfile(pluginsDir)).plugins)).toEqual(['brand-name.dusk'])
  })

  it('installs a folder without a publisher as local', async () => {
    const source = await tempRoot('orca-derived-folder-')
    const pluginsDir = await tempRoot('orca-derived-installs-')
    await writeThemePlugin(source)

    await expect(
      installPluginFromLocalPath({ pluginsDir, sourcePath: source, hostVersion: HOST })
    ).resolves.toMatchObject({ ok: true, pluginKey: 'local.dusk' })
  })

  it('discovers installed and development plugins under their derived publisher', async () => {
    const installedSource = await tempRoot('orca-derived-installed-')
    const devFolder = await tempRoot('orca-derived-dev-')
    const legacyDevFolder = await tempRoot('orca-derived-legacy-dev-')
    const pluginsDir = await tempRoot('orca-derived-installs-')
    await writeThemePlugin(installedSource)
    await writeThemePlugin(devFolder)
    await writeThemePlugin(legacyDevFolder, 'acme')
    await installPluginFromLocalPath({ pluginsDir, sourcePath: installedSource, hostVersion: HOST })

    const discovered = await discoverPlugins({
      pluginsDir,
      devPluginPaths: [devFolder, legacyDevFolder],
      hostVersion: HOST
    })

    expect(
      discovered.map((plugin) =>
        isInvalidDiscoveredPlugin(plugin)
          ? plugin.error
          : [plugin.pluginKey, plugin.manifest.publisher, plugin.isDev]
      )
    ).toEqual([
      // Why replaced: a dev folder overrides an installed copy with the same key.
      ['local.dusk', 'local', true],
      ['acme.dusk', 'acme', true]
    ])
  })
})
