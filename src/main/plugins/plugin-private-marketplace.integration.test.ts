import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginMarketplaceGitSource } from '../../shared/plugins/plugin-marketplace'
import { getUserPluginsDir } from './plugin-discovery'
import { readPluginLockfile } from './plugin-install'
import { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import { PluginMarketplaceService } from './plugin-marketplace-service'

const execFileAsync = promisify(execFile)
const temporaryRoots: string[] = []
const savedEnvironment = {
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
  GIT_SSH_VARIANT: process.env.GIT_SSH_VARIANT,
  ORCA_TEST_SSH_REPOSITORIES: process.env.ORCA_TEST_SSH_REPOSITORIES
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

async function createGitRepository(
  root: string,
  name: string,
  files: Record<string, string>
): Promise<string> {
  const repository = join(root, name)
  await mkdir(repository, { recursive: true })
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(repository, relativePath)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, contents, 'utf8')
  }
  await runGit(repository, ['init', '--quiet'])
  await runGit(repository, ['checkout', '--quiet', '-b', 'main'])
  await runGit(repository, ['add', '--all'])
  await runGit(repository, [
    '-c',
    'user.name=Orca Test',
    '-c',
    'user.email=orca-test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture'
  ])
  return repository
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('private Git marketplace integration', () => {
  it('uses the caller SSH environment for marketplace preview and install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-private-marketplace-'))
    temporaryRoots.push(root)
    const pluginKey = 'private.private-theme'
    const pluginUrl = 'ssh://git@example.invalid/private/theme.git'
    const marketplaceUrl = 'ssh://git@example.invalid/private/marketplace.git'
    const pluginRepository = await createGitRepository(root, 'theme-source', {
      'orca-plugin.json': JSON.stringify({
        manifestVersion: 1,
        id: 'private-theme',
        publisher: 'private',
        name: 'Private Theme',
        version: '1.0.0',
        engines: { orca: '>=1.4.0' },
        pluginApi: 1,
        contributes: {
          themes: [{ id: 'private', label: 'Private', path: 'theme.json' }]
        },
        capabilities: []
      }),
      'theme.json': JSON.stringify({
        id: 'private',
        label: 'Private',
        base: 'dark',
        tokens: { '--background': '#111111', '--foreground': '#eeeeee' }
      })
    })
    const marketplaceRepository = await createGitRepository(root, 'marketplace-source', {
      'orca-marketplace.json': JSON.stringify({
        name: 'Private Team Plugins',
        owner: 'private-team',
        plugins: [
          {
            id: pluginKey,
            source: { kind: 'git', url: pluginUrl, ref: 'main' },
            categories: ['themes']
          }
        ]
      })
    })
    const sshShim = join(root, 'git-ssh-shim.cjs')
    await writeFile(
      sshShim,
      await readFile(join(import.meta.dirname, 'plugin-private-marketplace-ssh-shim.cjs'), 'utf8'),
      'utf8'
    )
    process.env.GIT_SSH_COMMAND = `${shellQuote(process.execPath.replaceAll('\\', '/'))} ${shellQuote(sshShim.replaceAll('\\', '/'))}`
    process.env.GIT_SSH_VARIANT = 'ssh'
    process.env.ORCA_TEST_SSH_REPOSITORIES = JSON.stringify({
      '/private/theme.git': pluginRepository,
      '/private/marketplace.git': marketplaceRepository
    })

    const userDataPath = join(root, 'user-data')
    const marketplace = new PluginMarketplaceService({
      pluginsDataDir: join(userDataPath, 'plugins-data')
    })
    const source: PluginMarketplaceGitSource = {
      kind: 'git',
      url: marketplaceUrl,
      ref: 'main'
    }
    const registered = await marketplace.addSource(source)
    const installer = new PluginMarketplaceInstaller({
      marketplace,
      userDataPath,
      hostVersion: '1.4.0'
    })

    const preview = await installer.preview(registered.id, pluginKey)
    const installed = await installer.install(preview)

    expect(registered).toMatchObject({
      stale: false,
      marketplace: { name: 'Private Team Plugins' }
    })
    expect(preview).toMatchObject({ pluginKey, official: false, source: { url: pluginUrl } })
    expect(installed).toMatchObject({ ok: true, pluginKey })
    const lock = await readPluginLockfile(getUserPluginsDir(userDataPath))
    expect(lock.plugins[pluginKey]?.source).toMatchObject({
      kind: 'marketplace',
      marketplace: { url: marketplaceUrl },
      plugin: { url: pluginUrl }
    })
  })
})
