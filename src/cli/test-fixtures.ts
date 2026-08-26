import { afterEach, beforeEach, type Mock } from 'vitest'

type OkFixture = {
  id: string
  ok: true
  result: unknown
  _meta: { runtimeId: string }
}

type WorktreeFixture = {
  id: string
  repoId: string
  path: string
  branch: string
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: null
  linkedIssue: null
  git: {
    path: string
    head: string
    branch: string
    isBare: false
    isMainWorktree: false
  }
  displayName: string
  comment: string
}

export function buildWorktree(
  path: string,
  branch: string,
  head = 'abc',
  repoId = 'repo'
): WorktreeFixture {
  return {
    id: `${repoId}::${path}`,
    repoId,
    path,
    branch,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    linkedIssue: null,
    git: { path, head, branch, isBare: false, isMainWorktree: false },
    displayName: '',
    comment: ''
  }
}

export function worktreeListFixture(worktrees: WorktreeFixture[]): OkFixture {
  return {
    id: 'req_list',
    ok: true,
    result: { worktrees, totalCount: worktrees.length, truncated: false },
    _meta: { runtimeId: 'runtime-1' }
  }
}

export function okFixture(id: string, result: unknown): OkFixture {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

export function queueFixtures(mock: Mock, ...fixtures: OkFixture[]): void {
  for (const fixture of fixtures) {
    mock.mockResolvedValueOnce(fixture)
  }
}

// Why: these suites run inside an Orca terminal, which exports the very
// variables workspace targeting honours — leave them set and every cwd-default
// case silently asserts the developer's own worktree instead of the fixture.
export function isolateOrcaTerminalWorkspaceEnv(): void {
  const originalWorktreeId = process.env.ORCA_WORKTREE_ID
  const originalWorkspaceId = process.env.ORCA_WORKSPACE_ID

  beforeEach(() => {
    delete process.env.ORCA_WORKTREE_ID
    delete process.env.ORCA_WORKSPACE_ID
  })

  afterEach(() => {
    if (originalWorktreeId === undefined) {
      delete process.env.ORCA_WORKTREE_ID
    } else {
      process.env.ORCA_WORKTREE_ID = originalWorktreeId
    }
    if (originalWorkspaceId === undefined) {
      delete process.env.ORCA_WORKSPACE_ID
    } else {
      process.env.ORCA_WORKSPACE_ID = originalWorkspaceId
    }
  })
}
