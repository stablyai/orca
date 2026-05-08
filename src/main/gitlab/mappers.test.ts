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

  it("maps 'manual' to neutral so it doesn't stall pending forever", () => {
    expect(mapPipelineJobStatusToConclusion('manual')).toBe('neutral')
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
        detailed_merge_status: 'mergeable'
      },
      'pending'
    )
    expect(info.mergeable).toBe('CONFLICTING')
  })

  it('marks UNKNOWN when detailed_merge_status is non-mergeable but not a conflict', () => {
    const info = mapMRInfo(
      { iid: 1, title: 't', state: 'opened', detailed_merge_status: 'checking' },
      'pending'
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
    // Why: detail vs list endpoints differ — a `description` of '' on the
    // type would be ambiguous with "list payload that stripped the body".
    // Prefer absent over default '' so callers can tell them apart.
    const info = mapMRInfo({ iid: 5, title: 't', state: 'opened' }, 'success')
    expect('description' in info).toBe(false)
    expect('author' in info).toBe(false)
    expect('authorAvatarUrl' in info).toBe(false)
  })
})

// Why: mapMRToWorkItem / mapIssueToWorkItem tests live in
// mappers-workitem.test.ts so this file stays under the oxlint
// max-lines budget. Same import surface, same describe-per-export
// shape — split is mechanical, not behavioral.

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
    expect(derivePipelineStatus('manual')).toBe('neutral')
  })

  it('rolls up an array of jobs', () => {
    expect(derivePipelineStatus([{ status: 'success' }, { status: 'success' }])).toBe('success')
    expect(derivePipelineStatus([{ status: 'success' }, { status: 'failed' }])).toBe('failure')
    expect(derivePipelineStatus([{ status: 'success' }, { status: 'running' }])).toBe('pending')
  })

  it('failure beats pending in the rollup', () => {
    expect(derivePipelineStatus([{ status: 'failed' }, { status: 'running' }])).toBe('failure')
  })

  it('handles a single object with status', () => {
    expect(derivePipelineStatus({ status: 'success' })).toBe('success')
  })
})
