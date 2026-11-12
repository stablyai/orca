import { describe, expect, it } from 'vitest'
import { mapMRInfo } from './gitlab-response-mapping'

// GitLab marks a merge request without commits unmergeable but leaves its changes_count null.
describe('mapMRInfo', () => {
  it.each([
    { has_conflicts: true, detailed_merge_status: 'draft_status' },
    { has_conflicts: false, detailed_merge_status: 'broken_status' }
  ])('does not report conflicts for a merge request without a diff (%o)', (status) => {
    const info = mapMRInfo(
      { iid: 7, title: 'demo', state: 'opened', changes_count: null, ...status },
      'neutral'
    )
    expect(info.mergeable).toBe('UNKNOWN')
  })

  it.each([{ changes_count: '3' }, {}])(
    'keeps reporting conflicts when the diff is non-empty or not reported (%o)',
    (diff) => {
      const info = mapMRInfo(
        { iid: 7, title: 'demo', state: 'opened', has_conflicts: true, ...diff },
        'neutral'
      )
      expect(info.mergeable).toBe('CONFLICTING')
    }
  )
})
