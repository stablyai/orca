/**
 * Pins path-SPELLING parity between an `id:` selector and `path:`, deliberately not dedupe parity:
 * where two same-host rows spell one directory, `path:` collapses them to the first while `id:`
 * refuses as ambiguous, because this resolver also serves delete (#16243).
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
const REPO_PATH = '/srv/projects/app'
/** The spelling `git worktree list` reports. */
const WORKTREE_PATH = '/srv/projects/workspaces/plugin-host'
const CANONICAL_ID = `${REPO_ID}::${WORKTREE_PATH}`

/** One directory, other spellings a stored id can legitimately carry. */
const ID_SPELLINGS: [label: string, worktreePath: string, repoPath?: string][] = [
  ['a trailing slash', `${WORKTREE_PATH}/`],
  ['a doubled separator', '/srv/projects//workspaces/plugin-host'],
  ['an NFD workspace name', '/srv/projects/workspaces/café-plugin'.normalize('NFD')],
  // #15598/#15616: a Windows registration records backslashes; git reports forward slashes.
  ['a backslash Windows spelling', 'D:\\Agentic\\game2\\battle-core', 'D:/Agentic/game2']
]

/** What a scan reports for a stored id: the same directory, canonically spelled. */
function scannedSpellingOf(storedPath: string): string {
  const slashed = /^[A-Za-z]:[\\/]/.test(storedPath) ? storedPath.replace(/\\/g, '/') : storedPath
  return slashed.normalize('NFC').replace(/\/+/g, '/').replace(/\/$/, '')
}

/** One registered repo whose worktree meta is writable, so a delete's `forgetLocal` is observable. */
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
    async (_label, storedPath, repoPath) => {
      scanReports(scannedSpellingOf(storedPath), repoPath)
      const runtime = new OrcaRuntimeService(makeStore(repoPath) as never)

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
    async (_label, storedPath, repoPath) => {
      scanReports(scannedSpellingOf(storedPath), repoPath)
      const runtime = new OrcaRuntimeService(makeStore(repoPath) as never)
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
      runtime.showManagedWorktree(`id:${REPO_ID}::/srv/projects/workspaces/other-plugin`)
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
    const dotted = '/srv/projects/./workspaces/plugin-host'

    await expect(runtime.showManagedWorktree(`path:${dotted}`)).rejects.toThrow(
      'selector_not_found'
    )
    await expect(runtime.showManagedWorktree(`id:${REPO_ID}::${dotted}`)).rejects.toThrow(
      'selector_not_found'
    )
  })

  // #15598/#15616: on Windows one checkout is recorded under both spellings, and git reports the
  // forward-slash one. The backslash id itself rides the ID_SPELLINGS rows above; these pin the
  // folding limits around it.
  describe('Windows drive-letter spellings', () => {
    const WINDOWS_REPO = 'D:/Agentic/game2'
    const WINDOWS_WORKTREE = 'D:/Agentic/game2/battle-core'

    it('folds drive-letter case only for Windows paths, never for a POSIX path', async () => {
      scanReports(WINDOWS_WORKTREE, WINDOWS_REPO)
      const windowsRuntime = new OrcaRuntimeService(makeStore(WINDOWS_REPO) as never)

      // A Windows root is case-insensitive, as `path:` already treats it.
      await expect(
        windowsRuntime.showManagedWorktree(`id:${REPO_ID}::d:/agentic/game2/battle-core`)
      ).resolves.toMatchObject({ path: WINDOWS_WORKTREE })

      // A POSIX root is not: folding case there would merge distinct directories for a delete.
      scanReports(WORKTREE_PATH)
      const posixRuntime = new OrcaRuntimeService(makeStore() as never)

      await expect(
        posixRuntime.showManagedWorktree(`id:${REPO_ID}::/SRV/projects/workspaces/plugin-host`)
      ).rejects.toThrow('selector_not_found')
    })

    it('does not fold a backslash inside a POSIX path, where it is a valid filename character', async () => {
      scanReports(WORKTREE_PATH)
      const runtime = new OrcaRuntimeService(makeStore() as never)

      await expect(
        runtime.showManagedWorktree(`id:${REPO_ID}::/srv/projects\\workspaces\\plugin-host`)
      ).rejects.toThrow('selector_not_found')
    })
  })

  // The fail-closed guard on a delete-capable resolver: two rows spelling one directory must not
  // let a folded id pick one. `path:` collapses same-host duplicates; `id:` deliberately refuses.
  it('refuses a folded id when two same-repo rows spell one directory', async () => {
    listWorktreesStrictMock.mockResolvedValue([
      { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
      { path: WORKTREE_PATH, head: 'def', branch: 'feature', isBare: false, isMainWorktree: false },
      {
        path: '/srv/projects//workspaces/plugin-host',
        head: 'ghi',
        branch: 'feature-2',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(makeStore() as never)

    // Matches neither row exactly, folds to both.
    await expect(runtime.showManagedWorktree(`id:${CANONICAL_ID}/`)).rejects.toThrow(
      'selector_ambiguous'
    )
  })

  // Live-proof limit, pinned so nobody "fixes" the trimming: a folder-workspace id only trims a
  // trailing slash at end of string, so one placed before the instance suffix stays exact-only.
  it('keeps a folder-workspace id exact when a slash precedes the instance suffix', async () => {
    const instanceSuffix = '::workspace:123e4567-e89b-12d3-a456-426614174000'
    scanReports(WORKTREE_PATH)
    const runtime = new OrcaRuntimeService(makeStore() as never)

    await expect(
      runtime.showManagedWorktree(`id:${REPO_ID}::${WORKTREE_PATH}/${instanceSuffix}`)
    ).rejects.toThrow('selector_not_found')
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
