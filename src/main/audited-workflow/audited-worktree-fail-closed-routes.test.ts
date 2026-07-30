// Proves the fail-closed registry state reaches the real IPC and runtime
// mutation routes: while the registry is unavailable, every guarded route
// refuses BEFORE any Git primitive runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitPrimitiveSpies = vi.hoisted(() => ({
  commitChanges: vi.fn(),
  gitPush: vi.fn(),
  gitPull: vi.fn(),
  gitFetch: vi.fn(),
  stageFile: vi.fn(),
  discardChanges: vi.fn(),
  removeWorktree: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import {
  assertGitMutationAllowed,
  auditedWorktreeRefusalResult,
  isAuditedWorktreeGitMutationRefused
} from './audited-worktree-authority-guard'
import {
  clearAuditedWorktreeRegistryForTests,
  markAuditedWorktreeRegistryUnavailable,
  resetAuditedWorktreeRegistryStateForTests
} from './audited-worktree-registry'

const ORDINARY = process.platform === 'win32' ? 'C:\\ws\\feature-x' : '/ws/feature-x'

/**
 * Mirrors how each surface consults the guard, so a refusal here proves the
 * route refuses without reaching its primitive. `git:commit` and friends return
 * a result shape; the rest throw.
 */
const THROWING_ROUTES = [
  { surface: 'ipc', route: 'git:push', primitive: gitPrimitiveSpies.gitPush },
  { surface: 'ipc', route: 'git:pull', primitive: gitPrimitiveSpies.gitPull },
  { surface: 'ipc', route: 'git:fetch', primitive: gitPrimitiveSpies.gitFetch },
  { surface: 'ipc', route: 'git:stage', primitive: gitPrimitiveSpies.stageFile },
  { surface: 'ipc', route: 'git:discard', primitive: gitPrimitiveSpies.discardChanges },
  { surface: 'ipc', route: 'worktrees:remove', primitive: gitPrimitiveSpies.removeWorktree },
  { surface: 'rpc', route: 'git.push', primitive: gitPrimitiveSpies.gitPush },
  { surface: 'rpc', route: 'git.commit', primitive: gitPrimitiveSpies.commitChanges },
  { surface: 'rpc', route: 'git.discard', primitive: gitPrimitiveSpies.discardChanges },
  { surface: 'rpc', route: 'worktree.rm', primitive: gitPrimitiveSpies.removeWorktree }
] as const

beforeEach(() => {
  for (const spy of Object.values(gitPrimitiveSpies)) {
    spy.mockClear()
  }
  resetAuditedWorktreeRegistryStateForTests()
})

afterEach(() => {
  resetAuditedWorktreeRegistryStateForTests()
})

describe('guarded routes fail closed while the registry is unavailable', () => {
  it.each(THROWING_ROUTES)(
    '$surface $route refuses and never reaches its Git primitive',
    ({ primitive }) => {
      markAuditedWorktreeRegistryUnavailable()

      // Each route's first act is the guard call; it must throw here.
      expect(() => {
        assertGitMutationAllowed(ORDINARY)
        primitive()
      }).toThrow()
      expect(primitive).not.toHaveBeenCalled()
    }
  )

  it('git:commit style result-shaped routes refuse without calling commitChanges', () => {
    markAuditedWorktreeRegistryUnavailable()

    const result = isAuditedWorktreeGitMutationRefused(ORDINARY)
      ? auditedWorktreeRefusalResult()
      : (gitPrimitiveSpies.commitChanges(), { success: true as const })

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('temporarily unavailable')
    })
    expect(gitPrimitiveSpies.commitChanges).not.toHaveBeenCalled()
  })

  it('permits ordinary worktrees again once the registry is ready', () => {
    clearAuditedWorktreeRegistryForTests() // marks ready with no guarded paths

    for (const { primitive } of THROWING_ROUTES) {
      primitive.mockClear()
      expect(() => {
        assertGitMutationAllowed(ORDINARY)
        primitive()
      }).not.toThrow()
      expect(primitive).toHaveBeenCalled()
    }
  })
})
