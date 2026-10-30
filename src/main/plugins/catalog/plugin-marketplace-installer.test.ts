import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import {
  PLUGIN_SCHEMA_NEWEST_SINCE,
  pluginHostVersion
} from '../../../shared/plugins/installation/plugin-host-version'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginCatalogRelease } from '../../../shared/plugins/catalog/plugin-catalog-release'
import type { PluginMarketplace } from '../../../shared/plugins/catalog/plugin-marketplace'
import { readPluginLockfile, removeInstalledPlugin } from '../installation/plugin-install'
import { PluginImageCache } from '../plugin-image-cache'
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
    icon: boolean
    /** Directories of one repository listed as separate plugins named after them. */
    paths: string[] | null
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
    worker: false,
    icon: false,
    paths: null
  })
)

vi.mock('../installation/plugin-git-repository', () => ({
  checkoutPluginGitSource: git.checkout
}))

const telemetry = vi.hoisted(() => ({ track: vi.fn() }))
vi.mock('../../telemetry/client', () => telemetry)

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-marketplace-installer-'))
  roots.push(root)
  return root
}

function marketplace(): PluginMarketplace {
  if (git.paths) {
    return {
      name: 'Community',
      owner: 'community',
      plugins: git.paths.map((path) => ({
        id: `community.${path.split('/').at(-1)}`,
        source: { kind: 'git', url: git.pluginUrl, ref: 'stable', path },
        categories: []
      }))
    }
  }
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

async function writeCurrentPlugin(destination: string, path?: string): Promise<void> {
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
      id: path?.split('/').at(-1) ?? git.id,
      publisher: git.publisher,
      name: 'Notes',
      version: git.version,
      capabilities: [],
      ...(git.worker ? { main: 'worker.js' } : {}),
      ...(git.icon ? { icon: 'icon.png' } : {})
    })
  )
  if (git.icon) {
    await writeFile(join(destination, 'icon.png'), squarePng(128))
  }
  await writeFile(join(destination, 'payload.txt'), git.payload)
  if (git.worker) {
    await writeFile(join(destination, 'worker.js'), '')
  }
}

function squarePng(side: number): Buffer {
  const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const ihdr = [0, 0, 0, 13, ...Buffer.from('IHDR'), ...be32(side), ...be32(side), 8, 6, 0, 0, 0]
  return Buffer.from([...signature, ...ihdr, 0, 0, 0, 0])
}

async function setup(
  imageCache?: PluginImageCache,
  catalogUrl = 'https://github.com/community/plugins.git'
): Promise<{
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
  const added = await service.addSource({ kind: 'git', url: catalogUrl, ref: 'main' })
  return {
    root,
    marketplace: service,
    installer: new PluginMarketplaceInstaller({
      marketplace: service,
      userDataPath: root,
      hostVersion: pluginHostVersion('1.4.0'),
      ...(imageCache ? { imageCache } : {})
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
  git.icon = false
  git.paths = null
  telemetry.track.mockReset()
  git.checkout.mockReset()
  git.checkout.mockImplementation(
    async ({ destination, path }: { destination: string; path?: string }) => {
      await writeCurrentPlugin(destination, path)
      return git.commit
    }
  )
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

  it('previews without the image when the image cache cannot save it', async () => {
    git.v2 = true
    git.icon = true
    const cache = new PluginImageCache(join(await tempRoot(), 'images'))
    vi.spyOn(cache, 'put').mockRejectedValue(
      Object.assign(new Error('rename failed'), { code: 'ENOENT' })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { installer, sourceId } = await setup(cache)

    const preview = await installer.preview(sourceId, 'community.notes')
    expect(preview.manifest.icon).toBe('icon.png')
    expect(preview.images?.icon).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
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

  it('installs a full-access plugin with no global switch; approval stays per plugin', async () => {
    git.worker = true
    const { installer, sourceId, root } = await setup()
    const preview = await installer.preview(sourceId, 'community.notes')
    await expect(installer.install(preview)).resolves.toMatchObject({ ok: true })
    expect(Object.keys((await readPluginLockfile(join(root, 'plugins'))).plugins)).toEqual([
      'community.notes'
    ])
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

  it('keeps an install pinned to its catalog when a second catalog lists the same id', async () => {
    const { root, marketplace, installer, sourceId } = await setup()
    await installer.install(await installer.preview(sourceId, 'community.notes'))
    const mirror = await marketplace.addSource({
      kind: 'git',
      url: 'https://gitlab.com/mirror/group/plugins.git',
      ref: 'main'
    })
    git.commit = 'b'.repeat(40)
    git.version = '2.0.0'

    const switched = await installer.install(await installer.preview(mirror.id, 'community.notes'))

    expect(switched).toMatchObject({ ok: false, error: expect.stringContaining('remove it first') })
    const lock = await readPluginLockfile(join(root, 'plugins'))
    expect(lock.plugins['community.notes']).toMatchObject({
      version: '1.0.0',
      source: { marketplace: { url: 'https://github.com/community/plugins.git' } }
    })
    await expect(installer.previewInstalledUpdate('community.notes')).resolves.toMatchObject({
      marketplaceSourceId: sourceId
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

  it('installs two plugins from one repository side by side, each from its own directory', async () => {
    git.paths = ['plugins/notes', 'plugins/tasks']
    const { root, installer, sourceId } = await setup()
    for (const key of ['community.notes', 'community.tasks']) {
      await expect(
        installer.install(await installer.preview(sourceId, key))
      ).resolves.toMatchObject({ ok: true, pluginKey: key })
    }
    expect(git.checkout.mock.calls.map(([input]) => input.path)).toEqual([
      'plugins/notes',
      'plugins/notes',
      'plugins/tasks',
      'plugins/tasks'
    ])
    const lock = await readPluginLockfile(join(root, 'plugins'))
    expect(lock.plugins['community.notes']?.source).toMatchObject({
      plugin: { url: git.pluginUrl, ref: 'stable', path: 'plugins/notes' }
    })
    expect(lock.plugins['community.tasks']?.source).toMatchObject({
      plugin: { path: 'plugins/tasks' }
    })
  })

  it('treats a changed directory in the same repository as a moved plugin', async () => {
    git.paths = ['plugins/notes']
    const { marketplace: service, installer, sourceId } = await setup()
    await installer.install(await installer.preview(sourceId, 'community.notes'))

    git.paths = ['archive/notes']
    git.marketplaceCommit = 'e'.repeat(40)
    await service.refreshSource(sourceId)
    git.payload = 'moved'
    const movedPreview = await installer.previewInstalledUpdate('community.notes')
    expect(movedPreview).toMatchObject({ repositoryMoved: true })
    await expect(installer.install(movedPreview)).resolves.toMatchObject({
      ok: true,
      repositoryMoved: true
    })
  })

  it('reports public-catalog installs as install, reinstall, then update', async () => {
    const communityCatalog = 'https://github.com/stablyai/orca-community-plugins.git'
    const { installer, sourceId } = await setup(undefined, communityCatalog)
    const preview = await installer.preview(sourceId, 'community.notes')
    await installer.install(preview, { trigger: 'deep_link' })
    await installer.install(preview)
    git.commit = 'b'.repeat(40)
    git.version = '2.0.0'
    await installer.install(await installer.previewInstalledUpdate('community.notes'), {
      trigger: 'auto_update'
    })

    const base = { plugin_key: 'community.notes', catalog: 'community' }
    expect(telemetry.track.mock.calls).toEqual([
      ['plugin_installed', { ...base, version: '1.0.0', kind: 'install', trigger: 'deep_link' }],
      ['plugin_installed', { ...base, version: '1.0.0', kind: 'reinstall', trigger: 'catalog' }],
      ['plugin_installed', { ...base, version: '2.0.0', kind: 'update', trigger: 'auto_update' }]
    ])
  })

  it('never reports installs from a private catalog', async () => {
    const { installer, sourceId } = await setup()
    const result = await installer.install(await installer.preview(sourceId, 'community.notes'))

    expect(result.ok).toBe(true)
    expect(telemetry.track).not.toHaveBeenCalled()
  })
})
