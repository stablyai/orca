import { describe, expect, it, vi } from 'vitest'
import * as runtimePaths from '../../../src/shared/cross-platform-path'
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

  it('retains first spelling and host-specific path equivalence', () => {
    const paths = [
      ' /repo/café/ ',
      '/repo/cafe\u0301',
      '/repo//café',
      '/repo/Café',
      'C:\\Repo\\App',
      'c:/repo/app/',
      '\\\\server\\share\\App',
      '//SERVER/share/app/',
      '\\\\wsl.localhost\\Ubuntu\\home\\App',
      '//wsl$/ubuntu/home/App/',
      '//wsl$/ubuntu/home/app',
      '//wsl$/Debian/home/App',
      '/repo/back\\slash',
      '/repo/back/slash',
      'relative/path',
      ' '
    ]
    const rows = paths.map((path, index) => worktree({ path, worktreeId: `w-${index}` }))
    expect(deriveMobileAiVaultScopePaths('project', rows[0], rows)).toEqual([
      '/repo/café/',
      '/repo/Café',
      'C:\\Repo\\App',
      '\\\\server\\share\\App',
      '\\\\wsl.localhost\\Ubuntu\\home\\App',
      '//wsl$/ubuntu/home/app',
      '//wsl$/Debian/home/App',
      '/repo/back\\slash',
      '/repo/back/slash'
    ])
  })

  it('normalizes each candidate once even with many duplicate siblings below the cap', () => {
    const rows = Array.from({ length: 1000 }, (_, index) =>
      worktree({ path: `/repo/app-${index % 32}`, worktreeId: `w-${index}` })
    )
    const normalize = vi.spyOn(runtimePaths, 'normalizeRuntimePathForComparison')
    try {
      const result = deriveMobileAiVaultScopePaths('project', rows[0], rows)
      expect(result).toEqual(Array.from({ length: 32 }, (_, index) => `/repo/app-${index}`))
      expect(normalize).toHaveBeenCalledTimes(rows.length + 1)
    } finally {
      normalize.mockRestore()
    }
  })
})
