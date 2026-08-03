import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginMarketplace } from '../../shared/plugins/plugin-marketplace'
import { readPluginLockfile } from './plugin-install'
import { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import { PluginMarketplaceService } from './plugin-marketplace-service'

const git = vi.hoisted(() => ({
  checkout: vi.fn(),
  version: '1.0.0',
  publisher: 'community',
  id: 'notes',
  commit: 'a'.repeat(40),
  payload: 'first'
}))

vi.mock('./plugin-git-repository', () => ({
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
          url: 'https://github.com/community/notes.git',
          ref: 'stable'
        },
        categories: ['productivity']
      }
    ]
  }
}

async function writeCurrentPlugin(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  await writeFile(
    join(destination, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: git.id,
      publisher: git.publisher,
      name: 'Notes',
      version: git.version,
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      capabilities: []
    })
  )
  await writeFile(join(destination, 'payload.txt'), git.payload)
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
    fetcher: async () => ({ marketplaceCommit: 'f'.repeat(40), marketplace: marketplace() })
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
      hostVersion: '1.4.0'
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
})
