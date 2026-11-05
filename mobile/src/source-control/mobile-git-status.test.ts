import { describe, expect, it } from 'vitest'
import {
  buildMobileSourceControlSections,
  getStageablePaths,
  isMobileGitDiscardableEntry,
  isMobileGitStageableEntry,
  type MobileGitStatusEntry
} from './mobile-git-status'

describe('mobile source control status helpers', () => {
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

  it('pins conflicts into their own section ahead of changes, like desktop', () => {
    const sections = buildMobileSourceControlSections(
      [
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
      ],
      'changes-first'
    )

    expect(
      sections.map((section) => [section.title, section.data.map((entry) => entry.path)])
    ).toEqual([
      ['Conflicts', ['alpha.ts', 'beta.ts']],
      ['Uncommitted', ['aardvark.ts', 'zeta.ts']]
    ])
  })
})
