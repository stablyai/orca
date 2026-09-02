import type { Mock } from 'vitest'

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

/** The project read a CLI automation write makes to fence the host it lands on. */
export function localRepoDestinationFixtures(repoId = 'repo-1'): OkFixture[] {
  return [okFixture('req_repo_show', { repo: { id: repoId, connectionId: null } })]
}

/** A workspace selector resolves through its workspace before its project. */
export function workspaceDestinationFixtures(
  repoId = 'repo-1',
  worktreePath = '/tmp/repo/feature'
): OkFixture[] {
  return [
    okFixture('req_worktree_show', { worktree: { id: `${repoId}::${worktreePath}`, repoId } }),
    ...localRepoDestinationFixtures(repoId)
  ]
}

export function queueFixtures(mock: Mock, ...fixtures: OkFixture[]): void {
  for (const fixture of fixtures) {
    mock.mockResolvedValueOnce(fixture)
  }
}
