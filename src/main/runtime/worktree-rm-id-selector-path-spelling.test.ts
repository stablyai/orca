/**
 * #16243: "Delete Workspace" in the sidebar resolves nothing on a paired runtime while
 * `orca worktree rm --worktree "path:<dir>" --force` removes the very same workspace.
 *
 * The renderer can only address a workspace by its id (`toRuntimeWorktreeSelector` always emits
 * `id:<repoId>::<path>`), and the runtime matched that id by exact string equality — while a
 * `path:` selector has always compared through `normalizeRuntimePathForComparison`. A stored id
 * spelling its path differently from `git worktree list` therefore resolved for the CLI and
 * answered `selector_not_found` for the UI, which read that as a stale local mirror, ran
 * `forgetLocal`, reported success, and let the row return on the next refresh: a silent no-op.
 *
 * The contract pinned here is parity: an `id:` selector resolves what the same workspace's `path:`
 * selector resolves, and refuses what it refuses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})
vi.mock('electron', () => electronMocks)

const getSshGitProviderMock = vi.hoisted(() => vi.fn())
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: vi.fn(() => 0),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'unavailable',
  requireSshGitProvider: (connectionId: string) => getSshGitProviderMock(connectionId)
}))

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())
vi.mock('../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock
}))

import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'repo-local'
const REPO_PATH = '/data/projects/app'
/** The spelling `git worktree list` reports. */
const WORKTREE_PATH = '/data/projects/workspaces/headlamp-plugin'
const CANONICAL_ID = `${REPO_ID}::${WORKTREE_PATH}`

/** One directory, other spellings a stored id can legitimately carry. */
const ID_SPELLINGS: [label: string, worktreePath: string][] = [
  ['a trailing slash', `${WORKTREE_PATH}/`],
  ['a doubled separator', '/data/projects//workspaces/headlamp-plugin'],
  ['an NFD workspace name', '/data/projects/workspaces/café-plugin'.normalize('NFD')]
]

/** What a scan reports for a stored id: the same directory, canonically spelled. */
function scannedSpellingOf(storedPath: string): string {
  return storedPath.normalize('NFC').replace(/\/+/g, '/').replace(/\/$/, '')
}

function makeStore(repoPath: string = REPO_PATH) {
  const metaById: Record<string, Record<string, unknown>> = {}
  const store = {
    getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
    getRepos: () => [
      { id: REPO_ID, path: repoPath, displayName: 'app', badgeColor: 'blue', addedAt: 1 }
    ],
    getAllWorktreeMeta: vi.fn(() => metaById),
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: (id: string, meta: Record<string, unknown>) => {
      metaById[id] = { ...metaById[id], ...meta }
      return metaById[id]
    },
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn(),
    getGitHubCache: () => undefined as never,
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
  return store
}

/** `git worktree list` output: the main checkout plus one workspace at `worktreePath`. */
function scanReports(worktreePath: string, repoPath: string = REPO_PATH): void {
  listWorktreesStrictMock.mockResolvedValue([
    { path: repoPath, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
    { path: worktreePath, head: 'def', branch: 'feature', isBare: false, isMainWorktree: false }
  ])
}

type RemovalInternals = {
  resolveWorktreeRemovalTarget: (
    worktreeSelector: string,
    requiredHostId?: string
  ) => Promise<{ id: string; repoId: string; path: string }>
}

beforeEach(() => {
  getSshGitProviderMock.mockReset()
  listWorktreesStrictMock.mockReset()
})

describe('worktree id selectors vs. the path spelling git reports (#16243)', () => {
  it.each(ID_SPELLINGS)(
    'resolves through the fleet path what `path:` resolves when the id carries %s',
    async (_label, storedPath) => {
      scanReports(scannedSpellingOf(storedPath))
      const runtime = new OrcaRuntimeService(makeStore() as never)

      // The CLI's shape, and the live data point: `path:` already resolves it.
      const byPath = await runtime.showManagedWorktree(`path:${storedPath}`)
      // The only shape the renderer can send must resolve the SAME workspace.
      await expect(
        runtime.showManagedWorktree(`id:${REPO_ID}::${storedPath}`)
      ).resolves.toMatchObject({ id: byPath.id, path: byPath.path })
    }
  )

  it.each(ID_SPELLINGS)(
    'resolves a host-qualified removal target when the id carries %s',
    async (_label, storedPath) => {
      scanReports(scannedSpellingOf(storedPath))
      const runtime = new OrcaRuntimeService(makeStore() as never)
      const internals = runtime as unknown as RemovalInternals

      // The scoped path the UI's delete takes must agree with the fleet path above.
      await expect(
        internals.resolveWorktreeRemovalTarget(
          `id:${REPO_ID}::${storedPath}`,
          LOCAL_EXECUTION_HOST_ID
        )
      ).resolves.toMatchObject({ repoId: REPO_ID, path: scannedSpellingOf(storedPath) })
    }
  )

  it('still refuses an id whose path names a different workspace', async () => {
    scanReports(WORKTREE_PATH)
    const runtime = new OrcaRuntimeService(makeStore() as never)

    await expect(
      runtime.showManagedWorktree(`id:${REPO_ID}::/data/projects/workspaces/other-plugin`)
    ).rejects.toThrow('selector_not_found')
  })

  // STA-4343: matching across repo ids would delete a workspace the caller never confirmed.
  it('still refuses the same path under a different repo id', async () => {
    scanReports(WORKTREE_PATH)
    const runtime = new OrcaRuntimeService(makeStore() as never)

    await expect(runtime.showManagedWorktree(`id:other-repo::${WORKTREE_PATH}/`)).rejects.toThrow(
      'selector_not_found'
    )
  })

  it('still refuses a removal qualified to a host that does not own the repo id', async () => {
    scanReports(WORKTREE_PATH)
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const internals = runtime as unknown as RemovalInternals

    await expect(
      internals.resolveWorktreeRemovalTarget(`id:${CANONICAL_ID}/`, 'runtime:env-b')
    ).rejects.toThrow('selector_not_found')
  })

  it('keeps `id:` and `path:` agreeing on a dot segment neither canonicalizes', async () => {
    scanReports(WORKTREE_PATH)
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const dotted = '/data/projects/./workspaces/headlamp-plugin'

    await expect(runtime.showManagedWorktree(`path:${dotted}`)).rejects.toThrow(
      'selector_not_found'
    )
    await expect(runtime.showManagedWorktree(`id:${REPO_ID}::${dotted}`)).rejects.toThrow(
      'selector_not_found'
    )
  })

  // #15598/#15616: on Windows one checkout is recorded under both spellings, and git reports the
  // forward-slash one. The same divergence class, reaching the selector instead of a purge check.
  describe('Windows drive-letter spellings', () => {
    const WINDOWS_REPO = 'D:/Agentic/game2'
    const WINDOWS_WORKTREE = 'D:/Agentic/game2/battle-core'
    const BACKSLASH_ID = `${REPO_ID}::D:\\Agentic\\game2\\battle-core`

    it('resolves a backslash id against the forward-slash spelling git reports', async () => {
      scanReports(WINDOWS_WORKTREE, WINDOWS_REPO)
      const runtime = new OrcaRuntimeService(makeStore(WINDOWS_REPO) as never)

      await expect(runtime.showManagedWorktree(`id:${BACKSLASH_ID}`)).resolves.toMatchObject({
        id: `${REPO_ID}::${WINDOWS_WORKTREE}`,
        path: WINDOWS_WORKTREE
      })
    })

    it('resolves a host-qualified removal target for the backslash id', async () => {
      scanReports(WINDOWS_WORKTREE, WINDOWS_REPO)
      const runtime = new OrcaRuntimeService(makeStore(WINDOWS_REPO) as never)
      const internals = runtime as unknown as RemovalInternals

      await expect(
        internals.resolveWorktreeRemovalTarget(`id:${BACKSLASH_ID}`, LOCAL_EXECUTION_HOST_ID)
      ).resolves.toMatchObject({ repoId: REPO_ID, path: WINDOWS_WORKTREE })
    })

    it('folds drive-letter case only for Windows paths, never for a POSIX path', async () => {
      scanReports(WINDOWS_WORKTREE, WINDOWS_REPO)
      const runtime = new OrcaRuntimeService(makeStore(WINDOWS_REPO) as never)

      // A Windows root is case-insensitive, as `path:` already treats it.
      await expect(
        runtime.showManagedWorktree(`id:${REPO_ID}::d:/agentic/game2/battle-core`)
      ).resolves.toMatchObject({ path: WINDOWS_WORKTREE })
    })

    it('does not fold a backslash inside a POSIX path, where it is a valid filename character', async () => {
      scanReports(WORKTREE_PATH)
      const runtime = new OrcaRuntimeService(makeStore() as never)

      await expect(
        runtime.showManagedWorktree(`id:${REPO_ID}::/data/projects\\workspaces\\headlamp-plugin`)
      ).rejects.toThrow('selector_not_found')
    })
  })

  // #15616 guarantees malformed ids keep exact-match behavior; both sites must honour that too.
  it.each([
    ['no repo boundary', 'not-an-id'],
    ['an empty path', `${REPO_ID}::`]
  ])('keeps exact matching for a malformed id with %s', async (_label, malformedId) => {
    scanReports(WORKTREE_PATH)
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const internals = runtime as unknown as RemovalInternals

    await expect(runtime.showManagedWorktree(`id:${malformedId}`)).rejects.toThrow(
      'selector_not_found'
    )
    await expect(
      internals.resolveWorktreeRemovalTarget(`id:${malformedId}`, LOCAL_EXECUTION_HOST_ID)
    ).rejects.toThrow('selector_not_found')
  })
})
