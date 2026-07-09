import { describe, expect, it, vi } from 'vitest'

// resolvePrimaryBranch only reaches resolveDefaultBaseRefViaExec when
// worktreeBaseRef is unset; mock the heavy git modules so this runs pure.
vi.mock('../git/repo', () => ({
  resolveDefaultBaseRefViaExec: vi.fn(async () => 'main')
}))
vi.mock('../git/spotlight-sync', () => ({
  createLocalSpotlightGitContext: vi.fn()
}))

import type { Repo } from '../../shared/types'
import type { SpotlightGitContext } from '../../shared/spotlight-sync-core'
import { resolvePrimaryBranch } from './spotlight-service-state'

const ctx = {
  git: async () => ({ stdout: '' }),
  detectConflict: async () => 'unknown'
} as unknown as SpotlightGitContext

function repoWith(baseRef?: string): Repo {
  return { worktreeBaseRef: baseRef, path: '/repo' } as Repo
}

describe('resolvePrimaryBranch', () => {
  it('uses the configured base ref', async () => {
    expect(await resolvePrimaryBranch(ctx, repoWith('develop'), '/repo')).toBe('develop')
  })

  it('normalizes origin/ and refs/heads/ forms to the short branch name', async () => {
    expect(await resolvePrimaryBranch(ctx, repoWith('origin/develop'), '/repo')).toBe('develop')
    expect(await resolvePrimaryBranch(ctx, repoWith('refs/heads/main'), '/repo')).toBe('main')
  })

  it('falls back to the detected default branch when no base ref is configured', async () => {
    expect(await resolvePrimaryBranch(ctx, repoWith(undefined), '/repo')).toBe('main')
  })
})
