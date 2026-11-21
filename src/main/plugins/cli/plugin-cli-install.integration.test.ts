import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginApprovalRequiredError } from '../../../shared/plugins/approval/plugin-cli-approval'
import { PluginMarketplaceInstaller } from '../catalog/plugin-marketplace-installer'
import { PluginMarketplaceService } from '../catalog/plugin-marketplace-service'
import { readPluginLockfile } from '../installation/plugin-install-lockfile-store'
import {
  discoverPlugins,
  getUserPluginsDir,
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from '../discovery/plugin-discovery'
import { installPluginFromCli, type PluginCliInstallDeps } from './plugin-cli-install'
import { updatePluginFromCli } from './plugin-cli-update'

const execFileAsync = promisify(execFile)
const HOST_VERSION = '1.5.0'
const NOTES_URL = 'ssh://git@example.invalid/acme/notes.git'
const LOCALE_URL = 'ssh://git@example.invalid/acme/locale.git'
const roots: string[] = []
const savedEnvironment = {
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
  GIT_SSH_VARIANT: process.env.GIT_SSH_VARIANT,
  ORCA_TEST_SSH_REPOSITORIES: process.env.ORCA_TEST_SSH_REPOSITORIES
}

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync(
    'git',
    ['-c', 'user.name=Orca Test', '-c', 'user.email=t@example.invalid', ...args],
    { cwd }
  )
}

async function commitTag(repository: string, files: Record<string, string>, tag: string) {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(repository, path, '..'), { recursive: true })
    await writeFile(join(repository, path), contents, 'utf8')
  }
  await git(repository, ['add', '--all'])
  await git(repository, ['commit', '--quiet', '-m', tag])
  await git(repository, ['tag', tag])
}

function workerManifest(version: string, capabilities: { kind: string }[]): string {
  return JSON.stringify({
    manifestVersion: 2,
    id: 'notes',
    publisher: 'acme',
    name: 'Notes',
    version,
    engines: { orca: '>=1.4.245' },
    execution: 'trusted-worker',
    pluginApi: 1,
    main: 'main.mjs',
    contributes: { commands: [{ id: 'ping', title: 'Ping' }] },
    capabilities
  })
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** A Git SSH transport that serves known repositories and refuses the rest like a private host. */
async function sshShim(root: string, repositories: Record<string, string>): Promise<void> {
  const shim = join(root, 'ssh-shim.cjs')
  await writeFile(
    shim,
    `const { spawnSync } = require('node:child_process')
const match = /^git-upload-pack '([^']+)'$/.exec(process.argv.at(-1) ?? '')
const repository = match ? JSON.parse(process.env.ORCA_TEST_SSH_REPOSITORIES)[match[1]] : undefined
if (!repository) {
  process.stderr.write('git@example.invalid: Permission denied (publickey).\\n')
  process.exit(255)
}
process.exit(spawnSync('git', ['upload-pack', repository], { stdio: 'inherit' }).status ?? 1)
`,
    'utf8'
  )
  process.env.GIT_SSH_COMMAND = `${shellQuote(process.execPath.replaceAll('\\', '/'))} ${shellQuote(shim.replaceAll('\\', '/'))}`
  process.env.GIT_SSH_VARIANT = 'ssh'
  process.env.ORCA_TEST_SSH_REPOSITORIES = JSON.stringify(repositories)
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-cli-install-'))
  roots.push(root)
  const notes = join(root, 'notes')
  const locale = join(root, 'locale')
  for (const repository of [notes, locale]) {
    await mkdir(repository, { recursive: true })
    await git(repository, ['init', '--quiet'])
  }
  await commitTag(
    notes,
    {
      'orca-plugin.json': workerManifest('1.0.0', [{ kind: 'terminal:send' }]),
      'main.mjs': 'export {}\n'
    },
    'v1.0.0'
  )
  await commitTag(
    locale,
    {
      'orca-plugin.json': JSON.stringify({
        manifestVersion: 1,
        id: 'locale',
        publisher: 'acme',
        name: 'Locale',
        version: '1.0.0',
        engines: { orca: '>=1.4.0' },
        pluginApi: 1,
        contributes: { languagePacks: [{ locale: 'pt-BR', path: 'locale.json' }] },
        capabilities: []
      }),
      'locale.json': JSON.stringify({ settings: { title: 'Ajustes' } })
    },
    'v1.0.0'
  )
  const repositories: Record<string, string> = {
    '/acme/notes.git': notes,
    '/acme/locale.git': locale
  }
  await sshShim(root, repositories)
  const userDataPath = join(root, 'user-data')
  let discovered: DiscoveredPlugin[] = []
  const consents: Record<string, string> = {}
  const marketplace = new PluginMarketplaceService({ pluginsDataDir: join(userDataPath, 'data') })
  const service = {
    options: {
      userDataPath,
      hostVersion: HOST_VERSION,
      isPluginSystemEnabled: () => true,
      getPluginConsents: () => consents,
      getDisabledPlugins: () => [],
      getPluginKillListEntry: () => null
    },
    refresh: async () => {
      discovered = await discoverPlugins({
        pluginsDir: getUserPluginsDir(userDataPath),
        devPluginPaths: [],
        hostVersion: HOST_VERSION
      })
    },
    findValidPlugin: (key: string) =>
      discovered.find(
        (plugin): plugin is ValidDiscoveredPlugin =>
          !isInvalidDiscoveredPlugin(plugin) && plugin.pluginKey === key
      ) ?? null,
    recordApprovalAudit: vi.fn().mockResolvedValue(undefined)
  }
  const deps: PluginCliInstallDeps = {
    service,
    catalogs: {
      marketplace,
      installer: new PluginMarketplaceInstaller({
        marketplace,
        userDataPath,
        hostVersion: HOST_VERSION,
        revokeConsent: async (pluginKey) => {
          delete consents[pluginKey]
        }
      })
    },
    applyConsent: async ({ pluginKey, reviewedFingerprint }) => {
      consents[pluginKey] = reviewedFingerprint
    },
    executionHost: 'the Orca host (build-box)',
    caller: { kind: 'local-cli' }
  }
  const lock = async () => (await readPluginLockfile(getUserPluginsDir(userDataPath))).plugins
  return { root, deps, notes, locale, repositories, consents, lock }
}

async function approvalOf(promise: Promise<unknown>): Promise<PluginApprovalRequiredError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause
  )
  if (!(error instanceof PluginApprovalRequiredError)) {
    throw new Error(`expected approval_required, got ${String(error)}`)
  }
  return error
}

describe('orca plugin install and update over Git', () => {
  it('refuses code without --approve, writes nothing, and installs with the shown fingerprint', async () => {
    const { deps, lock } = await harness()
    const source = { kind: 'git' as const, input: NOTES_URL }

    const required = await approvalOf(installPluginFromCli(deps, source, undefined))
    expect(required.data.grants.execution).toBe('trusted-worker')
    expect(await lock()).toEqual({})

    await approvalOf(installPluginFromCli(deps, source, 'ap1-wrong'))

    const outcome = await installPluginFromCli(deps, source, required.data.approvalFingerprint)
    expect(outcome).toMatchObject({
      pluginKey: 'acme.notes',
      version: '1.0.0',
      approval: 'approve-flag'
    })
  })

  it('keeps approval across an update that asks for nothing new', async () => {
    const { deps, notes } = await harness()
    const first = await approvalOf(
      installPluginFromCli(deps, { kind: 'git', input: NOTES_URL }, undefined)
    )
    await installPluginFromCli(
      deps,
      { kind: 'git', input: NOTES_URL },
      first.data.approvalFingerprint
    )
    await commitTag(
      notes,
      {
        'orca-plugin.json': workerManifest('1.0.1', [{ kind: 'terminal:send' }]),
        'main.mjs': 'export const v = 2\n'
      },
      'v1.0.1'
    )

    const outcome = await updatePluginFromCli(deps, 'acme.notes', undefined)

    expect(outcome).toMatchObject({ status: 'updated', version: '1.0.1', approval: 'kept' })
    await expect(updatePluginFromCli(deps, 'acme.notes', undefined)).resolves.toMatchObject({
      status: 'up-to-date'
    })
  })

  it('holds an update that grows access until it is approved, leaving the running version', async () => {
    const { deps, notes, lock } = await harness()
    const first = await approvalOf(
      installPluginFromCli(deps, { kind: 'git', input: NOTES_URL }, undefined)
    )
    await installPluginFromCli(
      deps,
      { kind: 'git', input: NOTES_URL },
      first.data.approvalFingerprint
    )
    await commitTag(
      notes,
      {
        'orca-plugin.json': workerManifest('1.1.0', [
          { kind: 'terminal:send' },
          { kind: 'notifications:show' }
        ])
      },
      'v1.1.0'
    )

    const required = await approvalOf(updatePluginFromCli(deps, 'acme.notes', undefined))
    expect(required.data.action).toBe('update')
    expect(required.data.update?.growth?.capabilities).toEqual(['notifications:show'])
    expect((await lock())['acme.notes']?.version).toBe('1.0.0')

    const outcome = await updatePluginFromCli(deps, 'acme.notes', required.data.approvalFingerprint)
    expect(outcome).toMatchObject({ status: 'updated', version: '1.1.0', approval: 'approve-flag' })
  })

  it('asks again before a catalog update moves even a content-only plugin to another repository', async () => {
    const { root, deps, locale, repositories, consents, lock } = await harness()
    const catalog = join(root, 'catalog')
    const moved = join(root, 'moved-locale')
    await mkdir(catalog, { recursive: true })
    await git(catalog, ['init', '--quiet', '--initial-branch=master'])
    const listCatalog = (url: string, tag: string) =>
      commitTag(
        catalog,
        {
          'orca-marketplace.json': JSON.stringify({
            name: 'Team Plugins',
            owner: 'team',
            plugins: [{ id: 'acme.locale', source: { kind: 'git', url, ref: 'v1.0.0' } }]
          })
        },
        tag
      )
    await listCatalog(LOCALE_URL, 'c1')
    await execFileAsync('git', ['clone', '--quiet', locale, moved])
    await commitTag(moved, { 'locale.json': JSON.stringify({ settings: { title: 'Def' } }) }, 'v9')
    await git(moved, ['tag', '--force', 'v1.0.0'])
    await sshShim(root, {
      ...repositories,
      '/team/catalog.git': catalog,
      '/someone-else/locale.git': moved
    })
    await deps.catalogs.marketplace.addSource({
      kind: 'git',
      url: 'ssh://git@example.invalid/team/catalog.git',
      ref: 'master'
    })
    await installPluginFromCli(deps, { kind: 'catalog', pluginKey: 'acme.locale' }, undefined)
    const approved = consents['acme.locale']

    await listCatalog('ssh://git@example.invalid/someone-else/locale.git', 'c2')
    const required = await approvalOf(updatePluginFromCli(deps, 'acme.locale', undefined))

    expect(required.data.update?.repositoryMoved?.to).toContain('someone-else/locale')
    expect(consents['acme.locale']).toBe(approved)
    const installedCommit = (await lock())['acme.locale']?.resolvedCommit
    const outcome = await updatePluginFromCli(
      deps,
      'acme.locale',
      required.data.approvalFingerprint
    )
    expect(outcome).toMatchObject({ status: 'updated', approval: 'content-only' })
    expect((await lock())['acme.locale']?.resolvedCommit).not.toBe(installedCommit)
    // Dropped before the moved files published, then granted again by this explicit approval.
  })
})
