import { describe, expect, it } from 'vitest'
import {
  buildWorktreeShareSkipReport,
  formatWorktreeConfiguredPathSkip
} from './worktree-configured-path-skips'

describe('formatWorktreeConfiguredPathSkip', () => {
  it('names the share path and skip reason', () => {
    expect(
      formatWorktreeConfiguredPathSkip({
        mechanism: 'share',
        path: 'foo',
        reason: 'not-gitignored'
      })
    ).toBe('share: foo skipped (not gitignored)')
  })

  it('names the include path and copy-budget reason', () => {
    expect(
      formatWorktreeConfiguredPathSkip({
        mechanism: 'include',
        path: 'node_modules',
        reason: 'copy-budget',
        budgetReason: 'entries'
      })
    ).toBe('include: node_modules skipped (exceeds copy budget)')
  })

  it('names an unreadable share path separately from missing', () => {
    expect(
      formatWorktreeConfiguredPathSkip({
        mechanism: 'share',
        path: 'node_modules',
        reason: 'stat-failed'
      })
    ).toBe('share: node_modules skipped (unreadable)')
  })
})

describe('buildWorktreeShareSkipReport', () => {
  it('is empty when every share and include succeeded', () => {
    expect(
      buildWorktreeShareSkipReport({
        shareSkips: [],
        includeSkips: [],
        copySkips: []
      })
    ).toEqual({ warnings: [] })
  })

  it('surfaces a skipped share in warnings with path and reason', () => {
    const report = buildWorktreeShareSkipReport({
      shareSkips: [{ mechanism: 'share', path: 'foo', reason: 'not-gitignored' }],
      includeSkips: []
    })

    expect(report.warning).toBe('share: foo skipped (not gitignored)')
    expect(report.warnings).toEqual([
      expect.objectContaining({
        code: 'WORKTREE_SHARE_SKIPPED',
        message: 'share: foo skipped (not gitignored)',
        details: { path: 'foo', reason: 'not-gitignored' }
      })
    ])
  })

  it('surfaces a skipped include in warnings with path and reason', () => {
    const report = buildWorktreeShareSkipReport({
      shareSkips: [],
      includeSkips: [{ mechanism: 'include', path: 'node_modules', reason: 'missing' }]
    })

    expect(report.warning).toContain('include: node_modules skipped (missing)')
    expect(report.warnings[0]?.message).toContain('node_modules')
    expect(report.warnings[0]?.message).toContain('missing')
  })

  it('names a copy-budget skip without replacing the verbose copy warning', () => {
    const report = buildWorktreeShareSkipReport({
      shareSkips: [],
      includeSkips: [],
      copySkips: [{ path: 'node_modules', reason: 'entries' }],
      copyWarning: '.worktreeinclude entry "node_modules" was not copied'
    })

    expect(report.warning).toContain('"node_modules" was not copied')
    expect(report.warnings).toEqual([
      expect.objectContaining({
        code: 'WORKTREE_INCLUDE_SKIPPED',
        message: 'include: node_modules skipped (exceeds copy budget)',
        details: { path: 'node_modules', reason: 'copy-budget', budgetReason: 'entries' }
      })
    ])
  })

  it('names the first five skips and summarizes the rest', () => {
    const includeSkips = Array.from({ length: 7 }, (_, index) => ({
      mechanism: 'include' as const,
      path: `skip-${index}`,
      reason: 'missing' as const
    }))

    const report = buildWorktreeShareSkipReport({
      shareSkips: [],
      includeSkips
    })

    expect(report.warning).toBe(
      [
        'include: skip-0 skipped (missing)',
        'include: skip-1 skipped (missing)',
        'include: skip-2 skipped (missing)',
        'include: skip-3 skipped (missing)',
        'include: skip-4 skipped (missing)',
        'and 2 more'
      ].join('\n')
    )
    expect(report.warnings).toEqual([
      expect.objectContaining({ details: { path: 'skip-0', reason: 'missing' } }),
      expect.objectContaining({ details: { path: 'skip-1', reason: 'missing' } }),
      expect.objectContaining({ details: { path: 'skip-2', reason: 'missing' } }),
      expect.objectContaining({ details: { path: 'skip-3', reason: 'missing' } }),
      expect.objectContaining({ details: { path: 'skip-4', reason: 'missing' } }),
      {
        code: 'WORKTREE_INCLUDE_SKIPPED',
        message: 'and 2 more'
      }
    ])
  })
})
