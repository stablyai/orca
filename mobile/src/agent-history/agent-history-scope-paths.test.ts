import { describe, expect, it } from 'vitest'
import {
  deriveMobileAiVaultScopePaths,
  mobileAiVaultScanScopePaths,
  mobileAiVaultScopePathsKey,
  resolveActiveHistoryWorktree
} from './agent-history-scope-paths'

const worktree = (worktreeId: string, path: string) => ({ worktreeId, path, repoId: 'repo-1' })

describe('mobile AI Vault scope paths', () => {
  const active = worktree('w1', '/Users/ada/repo/app')
  const siblings = Array.from({ length: 200 }, (_, index) =>
    worktree(`w-sib-${index}`, `/Users/ada/repo/app-${index}`)
  )

  it('caps only the scan hints, so an older host accepts them and Project still shows every sibling', () => {
    const scopePaths = deriveMobileAiVaultScopePaths('project', active, [active, ...siblings])
    const scanPaths = mobileAiVaultScanScopePaths(scopePaths)

    expect(scopePaths).toHaveLength(201)
    expect(scanPaths).toHaveLength(64)
    // Active worktree is seeded first, so it survives truncation.
    expect(scanPaths[0]).toBe('/Users/ada/repo/app')
  })

  it('builds an identical key across fresh worktree arrays with the same paths', () => {
    const first = mobileAiVaultScopePathsKey('workspace', active, [active])
    const second = mobileAiVaultScopePathsKey('workspace', { ...active }, [{ ...active }])

    expect(first).toBe('/Users/ada/repo/app')
    expect(second).toBe(first)
    expect(mobileAiVaultScopePathsKey('workspace', null, [])).toBe('')
  })

  it('derives the active worktree path from repoId::path before worktree.ps settles when fastFirstScreen is enabled', () => {
    expect(resolveActiveHistoryWorktree([], 'repo-1::/Users/ada/repo/app', false)).toBeNull()
    expect(resolveActiveHistoryWorktree([], 'opaque-id', true)).toBeNull()
    expect(resolveActiveHistoryWorktree([], 'repo-1::/Users/ada/repo/app', true)).toMatchObject({
      worktreeId: 'repo-1::/Users/ada/repo/app',
      repoId: 'repo-1',
      path: '/Users/ada/repo/app'
    })
  })
})
