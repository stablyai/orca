import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeCreateResult } from '../../shared/runtime-types'
import { printLineageSummary } from './worktree-lineage-summary'

function createResult(
  overrides: Partial<RuntimeWorktreeCreateResult> = {}
): RuntimeWorktreeCreateResult {
  return {
    worktree: { id: 'wt' },
    lineage: null,
    warnings: [],
    ...overrides
  } as RuntimeWorktreeCreateResult
}

describe('printLineageSummary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints lineage and future non-lineage warnings, but not share/include skips', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    printLineageSummary(
      createResult({
        warnings: [
          { code: 'WORKTREE_SHARE_SKIPPED', message: 'share: foo skipped (missing)' },
          { code: 'WORKTREE_INCLUDE_SKIPPED', message: 'include: bar skipped (missing)' },
          { code: 'LINEAGE_PARENT_CONTEXT_MISSING', message: 'parent context missing' },
          { code: 'SETUP_HOOK_FAILED', message: 'setup failed' }
        ] as RuntimeWorktreeCreateResult['warnings']
      }),
      false
    )

    expect(err.mock.calls.map((call) => call[0])).toEqual([
      'warning: parent context missing',
      'warning: setup failed',
      'parent: none'
    ])
  })

  it('does not print warnings in json mode', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    printLineageSummary(
      createResult({
        warnings: [{ code: 'LINEAGE_PARENT_CONTEXT_MISSING', message: 'parent context missing' }]
      }),
      true
    )

    expect(err).not.toHaveBeenCalled()
  })
})
