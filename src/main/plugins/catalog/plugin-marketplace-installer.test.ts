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
import type { PluginImageCache } from '../plugin-image-cache'
import { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import { PluginMarketplaceService } from './plugin-marketplace-service'

const revokeConsent = vi.fn(async (_pluginKey: string) => undefined)

const git = vi.hoisted(
  (): {
    checkout: ReturnType<typeof vi.fn>
    version: string
    publisher: string | undefined
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
      ...(imageCache ? { imageCache } : {}),
      revokeConsent
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
  revokeConsent.mockClear()
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

  it('persists the catalog author repository with a mirrored installed release', async () => {
    git.v2 = true
    git.pluginUrl = 'https://github.com/mirrors/notes.git'
    const unpinned = await setup()
    const first = await unpinned.installer.preview(unpinned.sourceId, 'community.notes')
    git.release = {
      version: '1.0.0',
      commit: git.commit,
      contentHash: first.contentHash,
      execution: 'declarative',
      minimumOrca: PLUGIN_SCHEMA_NEWEST_SINCE,
      types: ['instructions'],
      repository: 'https://github.com/community/notes'
    }
    const { root, installer, sourceId } = await setup()
    const preview = await installer.preview(sourceId, 'community.notes')
    expect(await installer.install(preview)).toMatchObject({ ok: true })
    expect(
      (await readPluginLockfile(join(root, 'plugins'))).plugins['community.notes']
    ).toMatchObject({
      authorRepository: 'https://github.com/community/notes',
      source: { plugin: { url: 'https://github.com/mirrors/notes.git' } }
    })
    git.release.sourceUnavailable = true
    const unavailable = await setup()
    const unavailablePreview = await unavailable.installer.preview(
      unavailable.sourceId,
      'community.notes'
    )
    expect(await unavailable.installer.install(unavailablePreview)).toMatchObject({ ok: true })
    expect(
      (await readPluginLockfile(join(unavailable.root, 'plugins'))).plugins['community.notes']
    ).not.toHaveProperty('authorRepository')
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
    expect(revokeConsent).not.toHaveBeenCalled()

    git.pluginUrl = 'https://github.com/someone-else/notes.git'
    git.marketplaceCommit = 'd'.repeat(40)
    await service.refreshSource(sourceId)
    git.payload = 'moved'
    const movedPreview = await installer.previewInstalledUpdate('community.notes')
    expect(movedPreview).toMatchObject({ repositoryMoved: true })
    // Install links and catalog cards preview through `preview`, which must flag the move too.
    await expect(installer.preview(sourceId, 'community.notes')).resolves.toMatchObject({
      repositoryMoved: true
    })
    await expect(installer.install(movedPreview)).resolves.toMatchObject({
      ok: true,
      repositoryMoved: true
    })
    expect(revokeConsent).toHaveBeenCalledExactlyOnceWith('community.notes')
  })

  it('drops the approval before a moved repository publishes, and installs nothing if it cannot', async () => {
    const { root, marketplace: service, installer, sourceId } = await setup()
    await installer.install(await installer.preview(sourceId, 'community.notes'))
    git.pluginUrl = 'https://github.com/someone-else/notes.git'
    git.marketplaceCommit = 'd'.repeat(40)
    await service.refreshSource(sourceId)
    git.commit = 'b'.repeat(40)
    const moved = await installer.preview(sourceId, 'community.notes')
    const pluginsDir = join(root, 'plugins')
    revokeConsent.mockImplementationOnce(async () => {
      // The previous release must still be the published one when approval is dropped.
      expect((await readPluginLockfile(pluginsDir)).plugins['community.notes']).toMatchObject({
        resolvedCommit: 'a'.repeat(40)
      })
      throw new Error('settings unavailable')
    })

    await expect(installer.install(moved)).rejects.toThrow('settings unavailable')
    expect((await readPluginLockfile(pluginsDir)).plugins['community.notes']).toMatchObject({
      resolvedCommit: 'a'.repeat(40)
    })
  })
})
