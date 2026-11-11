import { describe, expect, it } from 'vitest'

import type { UsageScanWorktreeRef } from '../provider-lifecycle/usage-provider-contract'

import { createUsageWorktreeResolver } from './usage-worktree-resolver'

function worktree(path: string, index: number): UsageScanWorktreeRef {
  return {
    repoId: `repo-${index}`,
    worktreeId: `repo-${index}::${path}`,
    path,
    displayName: `Repo ${index}`
  }
}

describe('createUsageWorktreeResolver', () => {
  it('keeps containment semantics unchanged', async () => {
    const resolveWorktree = await createUsageWorktreeResolver([worktree('/workspace/repo', 1)])

    expect(resolveWorktree('/workspace/repo')?.worktreeId).toBe('repo-1::/workspace/repo')
    expect(resolveWorktree('/workspace/repo/packages/app')?.worktreeId).toBe(
      'repo-1::/workspace/repo'
    )
    // `..name` is a child directory; `..` escapes.
    expect(resolveWorktree('/workspace/repo/..fixtures/session')?.worktreeId).toBe(
      'repo-1::/workspace/repo'
    )
    expect(resolveWorktree('/workspace/repo/../other/session')).toBeNull()
    expect(resolveWorktree('/workspace/repo-sibling')).toBeNull()
  })

  it('does not treat a different Windows drive as contained', async () => {
    const resolveWorktree = await createUsageWorktreeResolver([worktree('C:\\repo', 1)])

    expect(resolveWorktree('C:\\repo\\packages\\app')?.worktreeId).toBe('repo-1::C:\\repo')
    expect(resolveWorktree('D:\\other\\repo')).toBeNull()
  })
})
