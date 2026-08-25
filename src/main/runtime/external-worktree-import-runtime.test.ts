import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

vi.mock('../ipc/filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))

const REPO_PATH = '/repo'
const SCRATCH_PATH = '/repo/.claude/worktrees/task'

type TestStore = {
  repo: Repo
  meta: WorktreeMeta | undefined
  updates: Partial<Repo>[]
  hostIds: (string | undefined)[]
}

function createStore(overrides: {
  meta?: WorktreeMeta
  importedExternalWorktreePaths?: string[]
  siblingHostRepo?: boolean
}): {
  store: unknown
  state: TestStore
} {
  const state: TestStore = {
    repo: {
      id: 'repo-1',
      path: REPO_PATH,
      displayName: 'repo',
      badgeColor: '#000000',
      addedAt: Date.UTC(2026, 4, 24),
      // Why: proves the scratch worktree stays hidden for reasons the repo-wide
      // setting cannot fix, which is the whole point of an explicit import.
      externalWorktreeVisibility: 'show',
      ...(overrides.importedExternalWorktreePaths
        ? { importedExternalWorktreePaths: overrides.importedExternalWorktreePaths }
        : {})
    } as Repo,
    meta: overrides.meta,
    updates: [],
    hostIds: []
  }
  // Why: a repo tracked on both a local and an SSH host shares one id, so `id:` lookups
  // are ambiguous and writes must be host-scoped. The SSH row is listed first on purpose,
  // so picking "the first match" is visibly wrong.
  const sshSibling = { ...state.repo, connectionId: 'ssh-1' } as Repo
  const store = {
    getRepo: () => state.repo,
    getRepos: () => (overrides.siblingHostRepo ? [sshSibling, state.repo] : [state.repo]),
    updateRepo: (_repoId: string, updates: Partial<Repo>, hostId?: string) => {
      state.updates.push(updates)
      state.hostIds.push(hostId)
      state.repo = { ...state.repo, ...updates }
      return state.repo
    },
    getWorktreeMeta: () => state.meta,
    getAllWorktreeMeta: () => ({}),
    getSettings: () => ({
      workspaceDir: '/orca/workspaces',
      nestWorkspaces: true,
      workspaceDirHistory: [],
      branchPrefix: 'none',
      branchPrefixCustom: '',
      refreshLocalBaseRefOnWorktreeCreate: false
    })
  }
  return { store, state }
}

function stubResolvedWorktree(
  runtime: OrcaRuntimeService,
  path = SCRATCH_PATH,
  hostId?: string
): void {
  const worktree: Worktree & { git: { path: string } } = {
    id: `repo-1::${path}`,
    repoId: 'repo-1',
    path,
    displayName: 'task',
    branch: 'refs/heads/task',
    head: 'abc123',
    isBare: false,
    isMainWorktree: path === REPO_PATH,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    git: { path },
    ...(hostId ? { hostId } : {})
  } as unknown as Worktree & { git: { path: string } }
  const internals = runtime as unknown as {
    resolveWorktreeSelector: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveWorktreeSelector').mockResolvedValue(worktree)
}

function createRuntime(
  overrides: {
    meta?: WorktreeMeta
    importedExternalWorktreePaths?: string[]
    siblingHostRepo?: boolean
    worktreeHostId?: string
  } = {},
  worktreePath = SCRATCH_PATH
): {
  runtime: OrcaRuntimeService
  state: TestStore
  worktreesChanged: string[]
} {
  const { store, state } = createStore(overrides)
  const runtime = new OrcaRuntimeService(store as never)
  stubResolvedWorktree(runtime, worktreePath, overrides.worktreeHostId)
  const worktreesChanged: string[] = []
  runtime.setNotifier({
    worktreesChanged: (repoId: string) => worktreesChanged.push(repoId),
    reposChanged: () => {}
  } as never)
  return { runtime, state, worktreesChanged }
}

describe('OrcaRuntimeService external worktree import', () => {
  it('records the path and tells clients to re-read worktree visibility', async () => {
    const { runtime, state, worktreesChanged } = createRuntime()

    const result = await runtime.importExternalWorktree(`path:${SCRATCH_PATH}`)

    expect(result.outcome).toBe('imported')
    expect(result.worktree.path).toBe(SCRATCH_PATH)
    expect(state.updates).toEqual([{ importedExternalWorktreePaths: [SCRATCH_PATH] }])
    // Why: repo updates alone only refresh repo records; without this event the
    // sidebar keeps the stale worktree list and the import looks like a no-op.
    expect(worktreesChanged).toEqual(['repo-1'])
  })

  it('does not write or notify when the path is already imported', async () => {
    const { runtime, state, worktreesChanged } = createRuntime({
      importedExternalWorktreePaths: [SCRATCH_PATH]
    })

    const result = await runtime.importExternalWorktree(`path:${SCRATCH_PATH}`)

    expect(result.outcome).toBe('already-imported')
    expect(state.updates).toEqual([])
    expect(worktreesChanged).toEqual([])
  })

  it('does not record worktrees Orca created', async () => {
    const { runtime, state, worktreesChanged } = createRuntime({
      meta: { orcaCreatedAt: 1 } as WorktreeMeta
    })

    const result = await runtime.importExternalWorktree(`path:${SCRATCH_PATH}`)

    expect(result.outcome).toBe('always-visible')
    expect(state.updates).toEqual([])
    expect(worktreesChanged).toEqual([])
  })

  it('does not record the repo checkout itself', async () => {
    const { runtime, state } = createRuntime({}, REPO_PATH)

    expect((await runtime.importExternalWorktree(`path:${REPO_PATH}`)).outcome).toBe(
      'always-visible'
    )
    expect(state.updates).toEqual([])
  })

  it('drops the path again on unimport and notifies once', async () => {
    const { runtime, state, worktreesChanged } = createRuntime({
      importedExternalWorktreePaths: ['/repo/other', SCRATCH_PATH]
    })

    const result = await runtime.unimportExternalWorktree(`path:${SCRATCH_PATH}`)

    expect(result.outcome).toBe('unimported')
    expect(state.updates).toEqual([{ importedExternalWorktreePaths: ['/repo/other'] }])
    expect(worktreesChanged).toEqual(['repo-1'])
  })

  it('reports a no-op unimport without writing', async () => {
    const { runtime, state, worktreesChanged } = createRuntime()

    expect((await runtime.unimportExternalWorktree(`path:${SCRATCH_PATH}`)).outcome).toBe(
      'not-imported'
    )
    expect(state.updates).toEqual([])
    expect(worktreesChanged).toEqual([])
  })

  it('imports against a repo id registered on two execution hosts', async () => {
    const { runtime, state, worktreesChanged } = createRuntime({
      siblingHostRepo: true,
      worktreeHostId: 'local'
    })

    // Why: `resolveRepoSelector('id:...')` would throw selector_ambiguous here even though the
    // caller's worktree selector named exactly one checkout.
    const result = await runtime.importExternalWorktree(`path:${SCRATCH_PATH}`)

    expect(result.outcome).toBe('imported')
    expect(state.updates).toEqual([{ importedExternalWorktreePaths: [SCRATCH_PATH] }])
    expect(worktreesChanged).toEqual(['repo-1'])
  })

  it('scopes the write to the host the worktree belongs to', async () => {
    const { runtime, state } = createRuntime({
      siblingHostRepo: true,
      worktreeHostId: 'local'
    })

    await runtime.importExternalWorktree(`path:${SCRATCH_PATH}`)

    // Why: without a hostId the store patches whichever row it finds first — the SSH sibling —
    // and the import lands on a repo the worktree does not belong to.
    expect(state.hostIds).toEqual(['local'])
  })

  it('refuses to guess when the resolved worktree names no host', async () => {
    const { runtime, state } = createRuntime({ siblingHostRepo: true })

    await expect(runtime.importExternalWorktree(`path:${SCRATCH_PATH}`)).rejects.toThrow(
      'selector_ambiguous'
    )
    expect(state.updates).toEqual([])
  })

  it('never writes worktree metadata, so the checkout keeps its own deletion semantics', async () => {
    const { runtime, state } = createRuntime()
    const internals = runtime as unknown as Record<string, unknown>
    const setWorktreeMeta = vi.fn()
    ;(internals.store as { setWorktreeMeta?: unknown }).setWorktreeMeta = setWorktreeMeta

    await runtime.importExternalWorktree(`path:${SCRATCH_PATH}`)

    expect(setWorktreeMeta).not.toHaveBeenCalled()
    expect(state.updates.every((update) => 'importedExternalWorktreePaths' in update)).toBe(true)
  })
})
