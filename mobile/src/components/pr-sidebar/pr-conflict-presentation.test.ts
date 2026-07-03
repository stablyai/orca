import { describe, expect, it } from 'vitest'
import type { PRInfo } from '../../../../src/shared/types'
import {
  buildMergeabilityRefreshCommands,
  hasMergeConflicts,
  resolveConflictDisplay
} from './pr-conflict-presentation'

function pr(over: Partial<PRInfo>): PRInfo {
  return {
    number: 1,
    title: 't',
    state: 'open',
    url: '',
    checksStatus: 'success',
    updatedAt: '',
    mergeable: 'MERGEABLE',
    ...over
  }
}

describe('hasMergeConflicts', () => {
  it('is true only for CONFLICTING', () => {
    expect(hasMergeConflicts(pr({ mergeable: 'CONFLICTING' }))).toBe(true)
    expect(hasMergeConflicts(pr({ mergeable: 'MERGEABLE' }))).toBe(false)
    expect(hasMergeConflicts(pr({ mergeable: 'UNKNOWN' }))).toBe(false)
  })
})

describe('resolveConflictDisplay', () => {
  it('builds safe mergeability refresh commands', () => {
    expect(buildMergeabilityRefreshCommands()).toBe(
      [
        'git fetch origin',
        'git commit --allow-empty --only -m "chore: refresh PR mergeability"',
        'git push'
      ].join('\n')
    )
  })

  it('returns null when there are no conflicts', () => {
    expect(resolveConflictDisplay(pr({ mergeable: 'MERGEABLE' }))).toBeNull()
    expect(resolveConflictDisplay(pr({ mergeable: 'UNKNOWN' }))).toBeNull()
  })

  it('lists conflicting files with commit metadata', () => {
    const display = resolveConflictDisplay(
      pr({
        mergeable: 'CONFLICTING',
        conflictSummary: {
          baseRef: 'main',
          baseCommit: 'abc1234',
          commitsBehind: 3,
          files: ['src/a.ts', 'src/b.ts']
        }
      })
    )
    expect(display).toEqual({
      files: ['src/a.ts', 'src/b.ts'],
      commitsBehind: 3,
      baseCommit: 'abc1234',
      fileDetailsUnavailable: false,
      localMergeClean: false,
      mergeabilityRefreshCommands: null
    })
  })

  it('flags file-details-unavailable when conflicting but no file list', () => {
    const display = resolveConflictDisplay(pr({ mergeable: 'CONFLICTING' }))
    expect(display).toEqual({
      files: [],
      commitsBehind: null,
      baseCommit: null,
      fileDetailsUnavailable: true,
      localMergeClean: false,
      mergeabilityRefreshCommands: null
    })
  })

  it('flags unavailable when conflictSummary has an empty file list', () => {
    const display = resolveConflictDisplay(
      pr({
        mergeable: 'CONFLICTING',
        conflictSummary: { baseRef: 'main', baseCommit: 'x', commitsBehind: 0, files: [] }
      })
    )
    expect(display?.fileDetailsUnavailable).toBe(true)
  })

  it('flags locally clean when GitHub reports a conflict that local git does not reproduce', () => {
    const display = resolveConflictDisplay(
      pr({
        mergeable: 'CONFLICTING',
        conflictSummary: {
          baseRef: 'main',
          baseCommit: 'x',
          commitsBehind: 1,
          files: [],
          localMergeState: 'clean'
        }
      })
    )
    expect(display?.localMergeClean).toBe(true)
    expect(display?.mergeabilityRefreshCommands).toContain('git fetch origin')
    expect(display?.mergeabilityRefreshCommands).toContain('git commit --allow-empty --only')
  })

  it('does not interpolate shell-sensitive base refs into copyable commands', () => {
    const display = resolveConflictDisplay(
      pr({
        mergeable: 'CONFLICTING',
        conflictSummary: {
          baseRef: 'release/$USER;echo unsafe',
          baseCommit: 'x',
          commitsBehind: 1,
          files: [],
          localMergeState: 'clean'
        }
      })
    )

    expect(display?.mergeabilityRefreshCommands).toContain('git fetch origin')
    expect(display?.mergeabilityRefreshCommands).not.toContain('$USER')
    expect(display?.mergeabilityRefreshCommands).not.toContain('echo unsafe')
  })
})
