import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { SshGitProvider } from '../providers/ssh-git-provider'
import { createMockMux } from '../providers/ssh-git-provider-test-harness'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { registerWorktreeCatalogHandlers } from './worktrees/listing/register-worktree-catalog-handlers'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args?: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), on: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))

const directories: string[] = []
afterEach(async () => {
  unregisterSshGitProvider('target')
  handlers.clear()
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function remoteRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'ssh-repo',
    path: '/srv/old',
    displayName: 'Remote project',
    badgeColor: 'blue',
    kind: 'git',
    addedAt: 1,
    executionHostId: 'ssh:target',
    connectionId: 'target',
    ...overrides
  }
}

function fixture(
  channel: 'worktrees:list' | 'worktrees:listAll',
  folderOrder?: 'folder-first' | 'git-first'
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-ssh-registration-')))
  directories.push(directory)
  const store = createSqliteTestStore(Store, { dataFile: join(directory, 'orca-data.json') })
  const folder = folderOrder
    ? remoteRepo({
        id: 'folder-repo',
        path: join(directory, 'folder'),
        kind: 'folder',
        executionHostId: 'local',
        connectionId: undefined
      })
    : undefined
  const repos = folder
    ? folderOrder === 'folder-first'
      ? [folder, remoteRepo()]
      : [remoteRepo(), folder]
    : [remoteRepo()]
  for (const repo of repos) {
    store.addRepo(repo)
  }
  const oldWorktreeId = 'ssh-repo::/srv/old-worktree'
  store.setWorktreeMeta(oldWorktreeId, { hostId: 'ssh:target', displayName: 'Retained remote row' })
  const mux = createMockMux()
  const provider = new SshGitProvider(
    'target',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listWorktrees uses only the harness request method and its controlled promise.
    mux as unknown as SshChannelMultiplexer
  )
  registerSshGitProvider('target', provider)
  registerWorktreeCatalogHandlers({ store })
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error('missing_registered_listing_handler')
  }
  return { store, mux, folder, oldWorktreeId, list: () => handler({}, { repoId: 'ssh-repo' }) }
}

function metadataSnapshot(store: Store) {
  return structuredClone({
    metadata: store.getAllWorktreeMeta(),
    lineage: store.getAllWorktreeLineage(),
    workspaceLineage: store.getAllWorkspaceLineage()
  })
}

describe.each(['worktrees:list', 'worktrees:listAll'] as const)(
  'registered %s SSH rejection after catalog mutation',
  (channel) => {
    it.each(['removed', 'replaced', 'kind-changed'] as const)(
      'rejects fallback rows from a %s captured registration',
      async (mutation) => {
        const { store, mux, list } = fixture(channel)
        const entered = Promise.withResolvers<void>()
        const reply = Promise.withResolvers<never>()
        mux.request.mockImplementationOnce(() => {
          entered.resolve()
          return reply.promise
        })
        const pending = list()
        try {
          await entered.promise
          if (mutation === 'kind-changed') {
            store.updateRepo('ssh-repo', { kind: 'folder' }, 'ssh:target')
          } else {
            store.deleteProjectHostSetup({ setupId: 'ssh-repo' })
            if (mutation === 'replaced') {
              store.addRepo(remoteRepo({ path: '/srv/new', addedAt: 2 }))
              store.setWorktreeMeta('ssh-repo::/srv/new-worktree', {
                hostId: 'ssh:target',
                displayName: 'Current remote row'
              })
            }
          }
          const current = metadataSnapshot(store)
          const metadataWrites = vi.spyOn(store, 'setWorktreeMetaForHost')
          reply.reject(new Error('SSH listing request failed'))
          expect(await pending).toEqual([])
          expect(metadataSnapshot(store)).toEqual(current)
          expect(metadataWrites).not.toHaveBeenCalled()
        } finally {
          reply.reject(new Error('fixture cleanup'))
          await pending
        }
      }
    )

    it('keeps current registration metadata available when its SSH listing fails', async () => {
      const { mux, oldWorktreeId, list } = fixture(channel)
      mux.request.mockRejectedValueOnce(new Error('SSH listing request failed'))
      expect(await list()).toEqual([
        expect.objectContaining({
          id: oldWorktreeId,
          path: '/srv/old-worktree',
          hostId: 'ssh:target',
          displayName: 'Retained remote row'
        })
      ])
    })
  }
)

describe.each(['folder-first', 'git-first'] as const)(
  'registered fleet admission while a sibling SSH listing waits: %s',
  (order) => {
    it.each(['kind-changed', 'unchanged', 'rejected'] as const)(
      'admits only current completed folder rows after a %s mutation',
      async (mutation) => {
        const { store, mux, folder, oldWorktreeId, list } = fixture('worktrees:listAll', order)
        if (!folder) {
          throw new Error('missing_folder_fixture')
        }
        const entered = Promise.withResolvers<void>()
        const reply = Promise.withResolvers<never>()
        mux.request.mockImplementationOnce(() => {
          entered.resolve()
          return reply.promise
        })
        const pending = list()
        try {
          await entered.promise
          const sibling = structuredClone(store.getRepo('ssh-repo'))
          if (mutation === 'rejected') {
            expect(() =>
              store.updateProjectHostSetup({
                setupId: folder.id,
                updates: { kind: 'git', path: join(folder.path, 'replacement') }
              })
            ).toThrow('paths must be changed by re-importing')
          } else {
            expect(
              store.updateRepo(
                folder.id,
                { kind: mutation === 'kind-changed' ? 'git' : 'folder' },
                'local'
              )?.kind
            ).toBe(mutation === 'kind-changed' ? 'git' : 'folder')
          }
          const selectedMetadata = structuredClone(store.getAllWorktreeMetaForHost('local'))
          reply.reject(new Error('SSH listing request failed'))
          const listed = await pending
          expect(listed).toHaveLength(mutation === 'kind-changed' ? 1 : 2)
          expect(listed).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: oldWorktreeId })])
          )
          expect(store.getRepo('ssh-repo')).toEqual(sibling)
          expect(store.getAllWorktreeMetaForHost('local')).toEqual(selectedMetadata)
        } finally {
          reply.reject(new Error('fixture cleanup'))
          await pending
        }
      }
    )
  }
)
