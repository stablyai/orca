import { describe, expect, it } from 'vitest'
import { getTrackedBranchesUpdate } from './worktree-tracked-branches'

function flagsOf(entries: Record<string, string | boolean>): Map<string, string | boolean> {
  return new Map(Object.entries(entries))
}

describe('getTrackedBranchesUpdate', () => {
  it('returns {} when neither flag is present', () => {
    expect(getTrackedBranchesUpdate(flagsOf({}), ['a'])).toEqual({})
  })

  it('adds comma-separated branches to the current list', () => {
    expect(
      getTrackedBranchesUpdate(flagsOf({ 'track-branch': 'task/x-v1.15.0, task/x-stage' }), [
        'task/x-dev'
      ])
    ).toEqual({ trackedBranches: ['task/x-dev', 'task/x-v1.15.0', 'task/x-stage'] })
  })

  it('re-tracking an existing branch is a no-op', () => {
    expect(getTrackedBranchesUpdate(flagsOf({ 'track-branch': 'refs/heads/a' }), ['a'])).toEqual({
      trackedBranches: ['a']
    })
  })

  it('clears with --clear-branches alone', () => {
    expect(getTrackedBranchesUpdate(flagsOf({ 'clear-branches': true }), ['a', 'b'])).toEqual({
      trackedBranches: []
    })
  })

  it('replaces when both flags are present', () => {
    expect(
      getTrackedBranchesUpdate(flagsOf({ 'clear-branches': true, 'track-branch': 'c' }), ['a', 'b'])
    ).toEqual({ trackedBranches: ['c'] })
  })

  it('rejects a bare --track-branch flag', () => {
    expect(() => getTrackedBranchesUpdate(flagsOf({ 'track-branch': true }), undefined)).toThrow(
      'Missing value for --track-branch'
    )
  })

  it('rejects branch names git would refuse', () => {
    expect(() =>
      getTrackedBranchesUpdate(flagsOf({ 'track-branch': 'has space' }), undefined)
    ).toThrow('Not a usable branch name: has space')
  })
})
