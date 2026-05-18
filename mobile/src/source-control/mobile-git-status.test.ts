import { describe, expect, expectTypeOf, it } from 'vitest'
import type { GitStatusResult } from '../../../src/shared/git-status-types'
import {
  buildMobileSourceControlSections,
  countStagedEntries,
  countUnstagedEntries,
  getStageablePaths,
  getUnstageablePaths,
  isMobileGitDiscardableEntry,
  isMobileGitStageableEntry,
  isMobileGitTransientRefreshError,
  isMobileGitUnavailable,
  type MobileGitStatusEntry,
  type MobileGitStatusResult
} from './mobile-git-status'

const entries: MobileGitStatusEntry[] = [
  { path: 'b.ts', status: 'modified', area: 'staged' },
  { path: 'a.ts', status: 'modified', area: 'unstaged' },
  { path: 'new.ts', status: 'untracked', area: 'untracked' }
]

describe('mobile source control status helpers', () => {
  it('keeps the mobile RPC status type in lockstep with the shared git contract', () => {
    expectTypeOf<MobileGitStatusResult>().toEqualTypeOf<GitStatusResult>()
  })

  it('builds sections in the mobile source control order', () => {
    const sections = buildMobileSourceControlSections(entries)

    expect(sections.map((section) => section.title)).toEqual([
      'Changes',
      'Untracked Files',
      'Staged Changes'
    ])
  })

  it('computes actionable path sets', () => {
    expect(countUnstagedEntries(entries)).toBe(2)
    expect(countStagedEntries(entries)).toBe(1)
    expect(getStageablePaths(entries)).toEqual(['a.ts', 'new.ts'])
    expect(getUnstageablePaths(entries)).toEqual(['b.ts'])
  })

  it('keeps unresolved conflicts out of stage actions', () => {
    const conflictedEntries: MobileGitStatusEntry[] = [
      { path: 'ready.ts', status: 'modified', area: 'unstaged' },
      {
        path: 'conflicted.ts',
        status: 'modified',
        area: 'unstaged',
        conflictStatus: 'unresolved'
      },
      {
        path: 'resolved.ts',
        status: 'modified',
        area: 'unstaged',
        conflictStatus: 'resolved_locally'
      }
    ]

    expect(getStageablePaths(conflictedEntries)).toEqual(['ready.ts', 'resolved.ts'])
    expect(isMobileGitStageableEntry(conflictedEntries[1])).toBe(false)
    expect(isMobileGitDiscardableEntry(conflictedEntries[1])).toBe(false)
    expect(isMobileGitDiscardableEntry(conflictedEntries[2])).toBe(false)
  })

  it('sorts entries by desktop-compatible conflict rank, then path', () => {
    const sections = buildMobileSourceControlSections([
      { path: 'zeta.ts', status: 'modified', area: 'unstaged' },
      {
        path: 'beta.ts',
        status: 'modified',
        area: 'unstaged',
        conflictStatus: 'resolved_locally'
      },
      {
        path: 'alpha.ts',
        status: 'modified',
        area: 'unstaged',
        conflictStatus: 'unresolved'
      },
      { path: 'aardvark.ts', status: 'added', area: 'unstaged' }
    ])

    expect(sections[0].data.map((entry) => entry.path)).toEqual([
      'alpha.ts',
      'beta.ts',
      'aardvark.ts',
      'zeta.ts'
    ])
  })

  it('recognizes old-desktop unavailable responses', () => {
    expect(isMobileGitUnavailable('forbidden', 'Method is not available to mobile clients')).toBe(
      true
    )
    expect(isMobileGitUnavailable('method_not_found', 'Unknown method')).toBe(true)
    expect(isMobileGitUnavailable('bad_request', 'Missing worktree selector')).toBe(false)
  })

  it('recognizes transient status refresh aborts', () => {
    expect(isMobileGitTransientRefreshError('runtime_error', 'Aborting')).toBe(true)
    expect(isMobileGitTransientRefreshError('request_aborted', 'request_aborted')).toBe(true)
    expect(isMobileGitTransientRefreshError('runtime_error', 'fatal: not a git repository')).toBe(
      false
    )
  })
})
