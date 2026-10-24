import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import {
  PLUGIN_SCHEMA_NEWEST_SINCE,
  pluginHostVersion
} from '../../../shared/plugins/plugin-host-version'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginCatalogRelease } from '../../../shared/plugins/catalog/plugin-catalog-release'
import type { PluginMarketplace } from '../../../shared/plugins/catalog/plugin-marketplace'
import { readPluginLockfile, removeInstalledPlugin } from '../installation/plugin-install'
import { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import { PluginMarketplaceService } from './plugin-marketplace-service'

const git = vi.hoisted(
  (): {
    checkout: ReturnType<typeof vi.fn>
    version: string
    publisher: string
    id: string
    commit: string
    payload: string
    v2: boolean
    release: PluginCatalogRelease | undefined
    pluginUrl: string
    marketplaceCommit: string
    worker: boolean
  } => ({
    checkout: vi.fn(),
    version: '1.0.0',
    publisher: 'community',
    id: 'notes',
    commit: 'a'.repeat(40),
    payload: 'first',
    v2: false,
    release: undefined,
    pluginUrl: 'https://github.com/community/notes.git',
    marketplaceCommit: 'f'.repeat(40),
    worker: false
  })
)

vi.mock('../installation/plugin-git-repository', () => ({
  checkoutPluginGitSource: git.checkout
}))

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-marketplace-installer-'))
  roots.push(root)
  return root
}

function marketplace(): PluginMarketplace {
  return {
    name: 'Community',
    owner: 'community',
    plugins: [
      {
        id: 'community.notes',
        source: {
          kind: 'git',
          url: git.pluginUrl,
          ref: 'stable'
        },
        categories: ['productivity'],
        ...(git.release ? { releases: [git.release] } : {})
      }
    ]
  }
}

async function writeCurrentPlugin(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  await writeFile(
    join(destination, 'orca-plugin.json'),
    JSON.stringify({
      ...(git.v2
        ? {
            manifestVersion: 2,
            execution: 'declarative',
            engines: { orca: `>=${PLUGIN_SCHEMA_NEWEST_SINCE}` },
            contributes: { commands: [{ id: 'tasks', title: 'Tasks', action: 'view.tasks' }] }
          }
        : { manifestVersion: 1, engines: { orca: '>=1.0.0' }, pluginApi: 1 }),
      id: git.id,
      publisher: git.publisher,
      name: 'Notes',
      version: git.version,
      capabilities: [],
      ...(git.worker ? { main: 'worker.js' } : {})
    })
  )
  await writeFile(join(destination, 'payload.txt'), git.payload)
  if (git.worker) {
    await writeFile(join(destination, 'worker.js'), '')
  }
}

async function setup(): Promise<{
  root: string
  marketplace: PluginMarketplaceService
  installer: PluginMarketplaceInstaller
  sourceId: string
}> {
  const root = await tempRoot()
  const service = new PluginMarketplaceService({
    pluginsDataDir: join(root, 'plugins-data'),
    fetcher: async () => ({ marketplaceCommit: git.marketplaceCommit, marketplace: marketplace() })
  })
  const added = await service.addSource({
    kind: 'git',
    url: 'https://github.com/community/plugins.git',
    ref: 'main'
  })
  return {
    root,
    marketplace: service,
    installer: new PluginMarketplaceInstaller({
      marketplace: service,
      userDataPath: root,
      hostVersion: pluginHostVersion('1.4.0')
    }),
    sourceId: added.id
  }
}

beforeEach(() => {
  git.version = '1.0.0'
  git.publisher = 'community'
  git.id = 'notes'
  git.commit = 'a'.repeat(40)
  git.payload = 'first'
  git.v2 = false
  git.release = undefined
  git.pluginUrl = 'https://github.com/community/notes.git'
  git.marketplaceCommit = 'f'.repeat(40)
  git.worker = false
  git.checkout.mockReset()
  git.checkout.mockImplementation(async ({ destination }: { destination: string }) => {
    await writeCurrentPlugin(destination)
    return git.commit
  })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginMarketplaceInstaller', () => {
  it('previews exact validated bytes and records marketplace provenance on install', async () => {
    const { root, installer, sourceId } = await setup()

    const preview = await installer.preview(sourceId, 'community.notes')
    expect(preview).toMatchObject({
      pluginKey: 'community.notes',
      resolvedCommit: 'a'.repeat(40),
      marketplaceCommit: 'f'.repeat(40),
      manifest: { version: '1.0.0' }
    })
    const result = await installer.install(preview)

    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result).toMatchObject({ ok: true, resolvedCommit: 'a'.repeat(40) })
    const lock = await readPluginLockfile(join(root, 'plugins'))
    expect(lock.plugins['community.notes']?.source).toEqual({
      kind: 'marketplace',
      marketplace: {
        url: 'https://github.com/community/plugins.git',
        ref: 'main',
        resolvedCommit: 'f'.repeat(40)
      },
      plugin: {
        url: 'https://github.com/community/notes.git',
        ref: 'stable'
      }
    })
  })

  it('requires a fresh review when the plugin ref moves after preview', async () => {
    const { root, installer, sourceId } = await setup()
    const preview = await installer.preview(sourceId, 'community.notes')
    git.commit = 'b'.repeat(40)
    git.version = '2.0.0'

    await expect(installer.install(preview)).resolves.toEqual({
      ok: false,
      error: 'plugin source changed after preview; review the update again'
    })
    await expect(readFile(join(root, 'plugins', 'plugins.lock.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('installs only the exact bytes a catalog release pins', async () => {
    git.v2 = true
    const unpinnedSetup = await setup()
    const unpinned = await unpinnedSetup.installer.preview(
      unpinnedSetup.sourceId,
      'community.notes'
    )
    git.release = {
      version: '1.0.0',
      commit: git.commit,
      contentHash: unpinned.contentHash,
      execution: 'declarative',
      minimumOrca: PLUGIN_SCHEMA_NEWEST_SINCE,
      types: ['instructions']
    }
    const { installer, sourceId } = await setup()
    const preview = await installer.preview(sourceId, 'community.notes')
    // The pinned commit is fetched directly, so the listed branch is display text only.
    expect(git.checkout).toHaveBeenLastCalledWith(expect.objectContaining({ ref: git.commit }))
    await expect(installer.install(preview)).resolves.toMatchObject({ ok: true })
    expect(git.checkout).toHaveBeenLastCalledWith(expect.objectContaining({ ref: git.commit }))
    git.payload = 'tampered at the same commit'

    await expect(installer.install(preview)).resolves.toEqual({
      ok: false,
      error: 'plugin bytes do not match the catalog release'
    })
    await expect(installer.preview(sourceId, 'community.notes')).rejects.toThrow(
      'plugin bytes do not match the catalog release'
    )
  })

  it('lists a release for a newer Orca but refuses it before downloading', async () => {
    git.release = {
      version: '1.0.0',
      commit: git.commit,
      contentHash: 'c'.repeat(64),
      execution: 'declarative',
      minimumOrca: '9.0.0',
      types: ['instructions']
    }
    const { marketplace, installer, sourceId } = await setup()
    await expect(marketplace.findPlugin(sourceId, 'community.notes')).resolves.toBeTruthy()

    await expect(installer.preview(sourceId, 'community.notes')).rejects.toThrow(
      `requires Orca >=9.0.0 (this is ${PLUGIN_SCHEMA_NEWEST_SINCE})`
    )
    await expect(
      installer.install({
        marketplaceSourceId: sourceId,
        marketplaceCommit: 'f'.repeat(40),
        pluginKey: 'community.notes',
        resolvedCommit: git.commit
      })
    ).resolves.toEqual({
      ok: false,
      error: `requires Orca >=9.0.0 (this is ${PLUGIN_SCHEMA_NEWEST_SINCE})`
    })
    expect(git.checkout).not.toHaveBeenCalled()
  })

  it('refuses a full-access release while the full access setting is off', async () => {
    git.release = {
      version: '1.0.0',
      commit: git.commit,
      contentHash: 'c'.repeat(64),
      execution: 'trusted-worker',
      minimumOrca: PLUGIN_SCHEMA_NEWEST_SINCE,
      types: ['instructions']
    }
    const { installer, sourceId } = await setup()
    await expect(
      installer.install({
        marketplaceSourceId: sourceId,
        marketplaceCommit: 'f'.repeat(40),
        pluginKey: 'community.notes',
        resolvedCommit: git.commit
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Allow full-access plugins')
    })
    expect(git.checkout).not.toHaveBeenCalled()
  })

  it('refuses an unpinned full-access plugin while the full access setting is off', async () => {
    git.worker = true
    const { installer, sourceId, root } = await setup()
    const preview = await installer.preview(sourceId, 'community.notes')
    await expect(installer.install(preview)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Allow full-access plugins')
    })
    expect((await readPluginLockfile(join(root, 'plugins'))).plugins).toEqual({})
  })

  it('rejects a source whose manifest identity differs from its listing', async () => {
    const { installer, sourceId } = await setup()
    git.publisher = 'attacker'

    await expect(installer.preview(sourceId, 'community.notes')).rejects.toThrow(
      'attacker.notes does not match marketplace listing community.notes'
    )
  })

  it('updates from recorded marketplace provenance and rolls back one immutable version', async () => {
    const { root, installer, sourceId } = await setup()
    const firstPreview = await installer.preview(sourceId, 'community.notes')
    const firstInstall = await installer.install(firstPreview)
    expect(firstInstall.ok).toBe(true)
    if (!firstInstall.ok) {
      return
    }

    git.commit = 'b'.repeat(40)
    git.version = '2.0.0'
    git.payload = 'second'
    const updatePreview = await installer.previewInstalledUpdate('community.notes')
    expect(updatePreview).toMatchObject({ resolvedCommit: 'b'.repeat(40) })
    await expect(installer.install(updatePreview)).resolves.toMatchObject({
      ok: true,
      version: '2.0.0'
    })
    await expect(installer.install(updatePreview)).resolves.not.toHaveProperty('repositoryMoved')

    await expect(installer.rollbackVersion('community.notes')).resolves.toBe('1.0.0')
    await expect(installer.rollbackVersion('not a key')).resolves.toBeNull()
    await expect(installer.rollback('community.notes')).resolves.toMatchObject({
      ok: true,
      version: '1.0.0',
      contentHash: firstInstall.contentHash
    })
    const lock = await readPluginLockfile(join(root, 'plugins'))
    expect(lock.plugins['community.notes']).toMatchObject({
      version: '1.0.0',
      resolvedCommit: 'a'.repeat(40)
    })
  })

  it('lets a Remove that starts during an automatic update win', async () => {
    const { root, installer, sourceId } = await setup()
    await installer.install(await installer.preview(sourceId, 'community.notes'))
    git.commit = 'b'.repeat(40)
    git.payload = 'second'
    const update = await installer.previewInstalledUpdate('community.notes')
    const pluginsDir = join(root, 'plugins')
    const [, result] = await Promise.all([
      removeInstalledPlugin({
        pluginsDir,
        pluginsDataDir: join(root, 'plugins-data'),
        pluginKey: 'community.notes'
      }),
      installer.install(update, { requireInstalled: true })
    ])
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('removed') })
    expect((await readPluginLockfile(pluginsDir)).plugins).toEqual({})
  })

  it('flags an update whose catalog moved the plugin to a different repository', async () => {
    const { marketplace: service, installer, sourceId } = await setup()
    await installer.install(await installer.preview(sourceId, 'community.notes'))

    git.pluginUrl = 'git@github.com:Community/Notes'
    git.marketplaceCommit = 'e'.repeat(40)
    await service.refreshSource(sourceId)
    git.payload = 'respelled'
    const respelledPreview = await installer.previewInstalledUpdate('community.notes')
    expect(respelledPreview).not.toHaveProperty('repositoryMoved')
    const respelled = await installer.install(respelledPreview)
    expect(respelled).toMatchObject({ ok: true })
    expect(respelled).not.toHaveProperty('repositoryMoved')

    git.pluginUrl = 'https://github.com/someone-else/notes.git'
    git.marketplaceCommit = 'd'.repeat(40)
    await service.refreshSource(sourceId)
    git.payload = 'moved'
    const movedPreview = await installer.previewInstalledUpdate('community.notes')
    expect(movedPreview).toMatchObject({ repositoryMoved: true })
    await expect(installer.install(movedPreview)).resolves.toMatchObject({
      ok: true,
      repositoryMoved: true
    })
  })
})
