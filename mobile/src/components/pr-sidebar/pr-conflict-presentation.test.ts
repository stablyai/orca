import { describe, expect, it } from 'vitest'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import { hasMergeConflicts, resolveConflictDisplay } from './pr-conflict-presentation'

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
  it('returns null when there are no conflicts', () => {
    expect(resolveConflictDisplay(pr({ mergeable: 'MERGEABLE' }))).toBeNull()
    expect(resolveConflictDisplay(pr({ mergeable: 'UNKNOWN' }))).toBeNull()
  })

  it('attributes the conflict to GitHub and names the base branch', () => {
    expect(resolveConflictDisplay(pr({ mergeable: 'CONFLICTING', baseRefName: 'main' }))).toEqual({
      title: 'GitHub reports conflicts with main',
      body: 'Merge main into this branch to see and resolve the conflicting files.'
    })
  })

  it('falls back to "the base branch" when the PR carries no base name', () => {
    expect(resolveConflictDisplay(pr({ mergeable: 'CONFLICTING' }))).toEqual({
      title: 'GitHub reports conflicts with the base branch',
      body: 'Merge the base branch into this branch to see and resolve the conflicting files.'
    })
  })
})
