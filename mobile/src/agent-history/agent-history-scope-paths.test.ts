import { describe, expect, it } from 'vitest'
import { deriveMobileAiVaultScopePaths } from './agent-history-scope-paths'

const worktree = (worktreeId: string, path: string) => ({ worktreeId, path, repoId: 'repo-1' })

describe('deriveMobileAiVaultScopePaths', () => {
  it('caps project scope at 64 paths so an older host RPC bound does not reject the request', () => {
    const active = worktree('w1', '/Users/ada/repo/app')
    const siblings = Array.from({ length: 200 }, (_, index) =>
      worktree(`w-sib-${index}`, `/Users/ada/repo/app-${index}`)
    )
    const result = deriveMobileAiVaultScopePaths('project', active, [active, ...siblings])
    expect(result.length).toBe(64)
    // Active worktree is seeded first, so it survives truncation.
    expect(result[0]).toBe('/Users/ada/repo/app')
  })
})
