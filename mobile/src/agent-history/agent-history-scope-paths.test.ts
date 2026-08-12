import { describe, expect, it } from 'vitest'
import type { Worktree } from '../worktree/workspace-list-types'
import { deriveMobileAiVaultScopePaths } from './agent-history-scope-paths'

function worktree(overrides: Partial<Worktree>): Pick<Worktree, 'worktreeId' | 'path' | 'repoId'> {
  return {
    worktreeId: overrides.worktreeId ?? 'w1',
    path: overrides.path ?? '/Users/ada/repo/app',
    repoId: overrides.repoId ?? 'repo-1'
  }
}

const active = worktree({ worktreeId: 'w1', path: '/Users/ada/repo/app', repoId: 'repo-1' })
const sibling = worktree({ worktreeId: 'w2', path: '/Users/ada/repo/app-2', repoId: 'repo-1' })
const otherRepo = worktree({ worktreeId: 'w3', path: '/Users/ada/other/ui', repoId: 'repo-2' })

describe('deriveMobileAiVaultScopePaths', () => {
  it('workspace scope returns only the active worktree path', () => {
    expect(
      deriveMobileAiVaultScopePaths('workspace', active, [active, sibling, otherRepo])
    ).toEqual(['/Users/ada/repo/app'])
  })

  it('project scope adds same-repo siblings but not other-repo worktrees', () => {
    expect(deriveMobileAiVaultScopePaths('project', active, [active, sibling, otherRepo])).toEqual([
      '/Users/ada/repo/app',
      '/Users/ada/repo/app-2'
    ])
  })

  it('all scope returns no scope hints (global recency list)', () => {
    expect(deriveMobileAiVaultScopePaths('all', active, [active, sibling])).toEqual([])
  })

  it('returns no paths when there is no active worktree', () => {
    expect(deriveMobileAiVaultScopePaths('workspace', null, [sibling])).toEqual([])
  })

  it('caps project scope at 64 paths so the host RPC bound does not reject the request', () => {
    const siblings = Array.from({ length: 200 }, (_, index) =>
      worktree({
        worktreeId: `w-sib-${index}`,
        path: `/Users/ada/repo/app-${index}`,
        repoId: 'repo-1'
      })
    )
    const result = deriveMobileAiVaultScopePaths('project', active, [active, ...siblings])
    expect(result.length).toBe(64)
    // Active worktree is seeded first, so it survives truncation.
    expect(result[0]).toBe('/Users/ada/repo/app')
  })

  it('dedupes and skips non-absolute paths', () => {
    const dupe = worktree({ worktreeId: 'w4', path: '/Users/ada/repo/app', repoId: 'repo-1' })
    const relative = worktree({ worktreeId: 'w5', path: 'relative/path', repoId: 'repo-1' })
    expect(deriveMobileAiVaultScopePaths('project', active, [active, dupe, relative])).toEqual([
      '/Users/ada/repo/app'
    ])
  })
})
