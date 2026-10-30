import { describe, expect, it } from 'vitest'
import {
  derivePipelineStatus,
  mapGitLabIssueInfo,
  mapMRInfo,
  mapMRState,
  mapPipelineJobStatusToCheckStatus,
  mapPipelineJobStatusToConclusion
} from './mappers'

describe('mapPipelineJobStatusToCheckStatus', () => {
  it('classifies queued lifecycle states', () => {
    expect(mapPipelineJobStatusToCheckStatus('created')).toBe('queued')
    expect(mapPipelineJobStatusToCheckStatus('pending')).toBe('queued')
    expect(mapPipelineJobStatusToCheckStatus('waiting_for_resource')).toBe('queued')
    expect(mapPipelineJobStatusToCheckStatus('preparing')).toBe('queued')
  })

  it('classifies running as in_progress', () => {
    expect(mapPipelineJobStatusToCheckStatus('running')).toBe('in_progress')
  })

  it('classifies success/failed/canceled/skipped/manual as completed', () => {
    expect(mapPipelineJobStatusToCheckStatus('success')).toBe('completed')
    expect(mapPipelineJobStatusToCheckStatus('failed')).toBe('completed')
    expect(mapPipelineJobStatusToCheckStatus('canceled')).toBe('completed')
    expect(mapPipelineJobStatusToCheckStatus('skipped')).toBe('completed')
    expect(mapPipelineJobStatusToCheckStatus('manual')).toBe('completed')
  })
})

describe('mapPipelineJobStatusToConclusion', () => {
  it('maps terminal outcomes', () => {
    expect(mapPipelineJobStatusToConclusion('success')).toBe('success')
    expect(mapPipelineJobStatusToConclusion('failed')).toBe('failure')
    expect(mapPipelineJobStatusToConclusion('canceled')).toBe('cancelled')
    expect(mapPipelineJobStatusToConclusion('canceling')).toBe('cancelled')
    expect(mapPipelineJobStatusToConclusion('skipped')).toBe('skipped')
  })

  it('keeps manual gates neutral while action-required stays actionable', () => {
    expect(mapPipelineJobStatusToConclusion('manual')).toBe('neutral')
    expect(mapPipelineJobStatusToConclusion('action_required')).toBe('action_required')
  })

  it('maps active lifecycle states to pending', () => {
    expect(mapPipelineJobStatusToConclusion('running')).toBe('pending')
    expect(mapPipelineJobStatusToConclusion('pending')).toBe('pending')
    expect(mapPipelineJobStatusToConclusion('scheduled')).toBe('pending')
  })

  it('returns null for unknown', () => {
    expect(mapPipelineJobStatusToConclusion('weird-status')).toBeNull()
  })
})

describe('mapMRState', () => {
  it('maps merged/closed/locked directly', () => {
    expect(mapMRState('merged')).toBe('merged')
    expect(mapMRState('closed')).toBe('closed')
    expect(mapMRState('locked')).toBe('locked')
  })

  it('returns draft when the draft flag is set', () => {
    expect(mapMRState('opened', true)).toBe('draft')
  })

  it("infers draft from a 'Draft:' title prefix", () => {
    expect(mapMRState('opened', false, 'Draft: refactor auth')).toBe('draft')
    expect(mapMRState('opened', undefined, 'WIP: in progress')).toBe('draft')
  })

  it("returns 'opened' for plain open MRs", () => {
    expect(mapMRState('opened', false, 'Add gitlab support')).toBe('opened')
    expect(mapMRState('opened')).toBe('opened')
  })
})

describe('mapGitLabIssueInfo', () => {
  it('uses iid as the number when present', () => {
    expect(
      mapGitLabIssueInfo({
        iid: 42,
        title: 'A',
        state: 'opened',
        web_url: 'https://gitlab.com/g/p/-/issues/42',
        labels: [{ name: 'bug' }, { name: 'p1' }]
      })
    ).toEqual({
      number: 42,
      title: 'A',
      state: 'opened',
      url: 'https://gitlab.com/g/p/-/issues/42',
      labels: ['bug', 'p1']
    })
  })

  it('falls back to number when iid is absent', () => {
    expect(mapGitLabIssueInfo({ number: 7, title: 'B', state: 'closed' })).toEqual({
      number: 7,
      title: 'B',
      state: 'closed',
      url: '',
      labels: []
    })
  })

  it('handles string-only labels', () => {
    expect(mapGitLabIssueInfo({ iid: 1, title: 'C', state: 'opened', labels: ['bug'] })).toEqual({
      number: 1,
      title: 'C',
      state: 'opened',
      url: '',
      labels: ['bug']
    })
  })

  it('passes description / author / authorAvatarUrl through when present', () => {
    const info = mapGitLabIssueInfo({
      iid: 9,
      title: 'bug',
      state: 'opened',
      description: 'Steps to reproduce.',
      author: { username: 'bob', avatar_url: 'https://example.com/b.png' }
    })
    expect(info.description).toBe('Steps to reproduce.')
    expect(info.author).toBe('bob')
    expect(info.authorAvatarUrl).toBe('https://example.com/b.png')
  })
})

describe('mapMRInfo', () => {
  it('settles mergeable manual pipelines without claiming they passed, while preserving blockers', () => {
    for (const pipelineField of ['head_pipeline', 'pipeline']) {
      for (const [status, detailed_merge_status, expected] of [
        ['manual', 'mergeable', 'neutral'],
        ['manual', 'ci_must_pass', 'pending'],
        ['manual', 'merge_request_blocked', 'pending'],
        ['manual', 'draft_status', 'pending'],
        ['manual', undefined, 'pending'],
        ['running', 'mergeable', 'pending'],
        ['failed', 'mergeable', 'failure']
      ] as const) {
        const raw = {
          iid: 1,
          title: 'Manual release stage',
          state: 'opened',
          [pipelineField]: { status },
          detailed_merge_status
        }
        const info = mapMRInfo(raw, derivePipelineStatus({ status }))
        expect(info.pipelineStatus, `${pipelineField}: ${status} / ${detailed_merge_status}`).toBe(
          expected
        )
      }
    }
  })

  it('builds an MRInfo from a typical glab payload', () => {
    expect(
      mapMRInfo(
        {
          iid: 10,
          title: 'Add gitlab support',
          state: 'opened',
          draft: false,
          web_url: 'https://gitlab.com/g/p/-/merge_requests/10',
          updated_at: '2026-05-05T10:00:00Z',
          sha: 'deadbeef',
          has_conflicts: false,
          detailed_merge_status: 'mergeable'
        },
        'success'
      )
    ).toEqual({
      number: 10,
      title: 'Add gitlab support',
      state: 'opened',
      url: 'https://gitlab.com/g/p/-/merge_requests/10',
      pipelineStatus: 'success',
      updatedAt: '2026-05-05T10:00:00Z',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'mergeable',
      headSha: 'deadbeef'
    })
  })

  it('marks CONFLICTING when has_conflicts is true', () => {
    const info = mapMRInfo(
      {
        iid: 1,
        title: 't',
        state: 'opened',
        has_conflicts: true,
        head_pipeline: { status: 'manual' },
        detailed_merge_status: 'mergeable'
      },
      'pending'
    )
    expect(info.mergeable).toBe('CONFLICTING')
    expect(info.mergeStateStatus).toBe('conflict')
    expect(info.pipelineStatus).toBe('pending')
  })

  it('marks UNKNOWN when detailed_merge_status is non-mergeable but not a conflict', () => {
    const info = mapMRInfo(
      { iid: 1, title: 't', state: 'opened', detailed_merge_status: 'checking' },
      'pending'
    )
    expect(info.mergeable).toBe('UNKNOWN')
    expect(info.mergeStateStatus).toBe('checking')
  })

  // GitLab <15.6 lacks detailed_merge_status; legacy positive mergeability keeps actions usable.
  it('falls back to legacy merge_status when detailed_merge_status is absent', () => {
    const info = mapMRInfo(
      {
        iid: 1,
        title: 't',
        state: 'opened',
        merge_status: 'can_be_merged',
        head_pipeline: { status: 'manual' }
      },
      'pending'
    )
    expect(info.mergeable).toBe('MERGEABLE')
    expect(info.pipelineStatus).toBe('pending')
  })

  it('does not let legacy merge_status override a present detailed_merge_status', () => {
    const info = mapMRInfo(
      {
        iid: 1,
        title: 't',
        state: 'opened',
        detailed_merge_status: 'not_approved',
        merge_status: 'can_be_merged'
      },
      'success'
    )
    expect(info.mergeable).toBe('UNKNOWN')
    expect(info.mergeStateStatus).toBe('not_approved')
  })

  it('keeps legacy cannot_be_merged as UNKNOWN rather than guessing a conflict', () => {
    const info = mapMRInfo(
      { iid: 1, title: 't', state: 'opened', merge_status: 'cannot_be_merged' },
      'success'
    )
    expect(info.mergeable).toBe('UNKNOWN')
  })

  it('returns draft state when draft flag is set', () => {
    const info = mapMRInfo({ iid: 1, title: 't', state: 'opened', draft: true }, 'neutral')
    expect(info.state).toBe('draft')
  })

  it('passes description / author / authorAvatarUrl through when present', () => {
    const info = mapMRInfo(
      {
        iid: 5,
        title: 't',
        state: 'opened',
        description: '## Body\n\nDetails here.',
        author: { username: 'alice', avatar_url: 'https://example.com/a.png' }
      },
      'success'
    )
    expect(info.description).toBe('## Body\n\nDetails here.')
    expect(info.author).toBe('alice')
    expect(info.authorAvatarUrl).toBe('https://example.com/a.png')
  })

  it('omits description / author when absent (distinguishes from list payloads)', () => {
    // Missing description means unloaded list data; empty string means a known blank body.
    const info = mapMRInfo({ iid: 5, title: 't', state: 'opened' }, 'success')
    expect('description' in info).toBe(false)
    expect('author' in info).toBe(false)
    expect('authorAvatarUrl' in info).toBe(false)
  })
})

describe('derivePipelineStatus', () => {
  it('returns neutral for null/undefined/empty', () => {
    expect(derivePipelineStatus(null)).toBe('neutral')
    expect(derivePipelineStatus(undefined)).toBe('neutral')
    expect(derivePipelineStatus([])).toBe('neutral')
  })

  it('classifies a top-level pipeline string', () => {
    expect(derivePipelineStatus('success')).toBe('success')
    expect(derivePipelineStatus('failed')).toBe('failure')
    expect(derivePipelineStatus('running')).toBe('pending')
    // Pipeline manual means blocked on human action, not failed or complete.
    expect(derivePipelineStatus('manual')).toBe('pending')
    expect(derivePipelineStatus({ status: 'manual' })).toBe('pending')
  })

  // Preserve pipeline-level neutral skipped/canceled states independently of job-level rollup tones.
  it('keeps skipped and canceled pipeline strings neutral (deferred tone changes)', () => {
    expect(derivePipelineStatus('skipped')).toBe('neutral')
    expect(derivePipelineStatus({ status: 'skipped' })).toBe('neutral')
    expect(derivePipelineStatus('canceled')).toBe('neutral')
    expect(derivePipelineStatus('canceling')).toBe('neutral')
    expect(derivePipelineStatus([{ status: 'canceled' }])).toBe('failure')
  })

  it('rolls up an array of jobs', () => {
    expect(derivePipelineStatus([{ status: 'success' }, { status: 'success' }])).toBe('success')
    expect(derivePipelineStatus([{ status: 'success' }, { status: 'failed' }])).toBe('failure')
    expect(derivePipelineStatus([{ status: 'success' }, { status: 'running' }])).toBe('pending')
  })

  it('failure beats pending in the rollup', () => {
    expect(derivePipelineStatus([{ status: 'failed' }, { status: 'running' }])).toBe('failure')
    expect(derivePipelineStatus([{ status: 'action_required' }, { status: 'success' }])).toBe(
      'failure'
    )
  })

  it('keeps a manual deploy gate from failing an otherwise green pipeline', () => {
    expect(derivePipelineStatus([{ status: 'manual' }, { status: 'success' }])).toBe('success')
  })

  it('leaves a manual-only pipeline unresolved rather than green', () => {
    expect(derivePipelineStatus([{ status: 'manual' }])).toBe('neutral')
    expect(derivePipelineStatus([{ status: 'manual' }, { status: 'manual' }])).toBe('neutral')
  })

  it('counts skipped jobs as passing', () => {
    expect(derivePipelineStatus([{ status: 'skipped' }, { status: 'skipped' }])).toBe('success')
  })

  it('handles a single object with status', () => {
    expect(derivePipelineStatus({ status: 'success' })).toBe('success')
  })

  it('keeps malformed and unknown array jobs neutral', () => {
    expect(derivePipelineStatus([{ status: 'future_status' }])).toBe('neutral')
    expect(derivePipelineStatus([{}])).toBe('neutral')
  })

  it('lets a passing job outweigh an unknown one', () => {
    expect(derivePipelineStatus([{ status: 'success' }, { status: 'future_status' }])).toBe(
      'success'
    )
  })
})
