import { describe, expect, it } from 'vitest'
import {
  derivePipelineStatus,
  mapGitLabIssueInfo,
  mapIssueToWorkItem,
  mapMRInfo,
  mapMRState,
  mapMRToWorkItem,
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
})

describe('mapMRToWorkItem', () => {
  it('produces a unified GitLabWorkItem with branch + author', () => {
    expect(
      mapMRToWorkItem(
        {
          id: 100,
          iid: 5,
          title: 'Add support',
          state: 'opened',
          web_url: 'https://gitlab.com/g/p/-/merge_requests/5',
          updated_at: '2026-05-05T10:00:00Z',
          source_branch: 'feat-x',
          target_branch: 'main',
          author: { username: 'alice' },
          source_project_id: 7,
          target_project_id: 7,
          labels: [{ name: 'bug' }, 'p1']
        },
        'g/p'
      )
    ).toEqual({
      id: 'gitlab-mr-100',
      type: 'mr',
      number: 5,
      title: 'Add support',
      state: 'opened',
      url: 'https://gitlab.com/g/p/-/merge_requests/5',
      labels: ['bug', 'p1'],
      updatedAt: '2026-05-05T10:00:00Z',
      author: 'alice',
      branchName: 'feat-x',
      baseRefName: 'main',
      isCrossRepository: false,
      repoId: 'g/p'
    })
  })

  it('flags cross-repository when source_project_id !== target_project_id', () => {
    const item = mapMRToWorkItem(
      {
        iid: 1,
        title: 't',
        state: 'opened',
        source_project_id: 5,
        target_project_id: 7
      },
      'g/p'
    )
    expect(item.isCrossRepository).toBe(true)
  })

  it('does not flag cross-repository when project ids are absent', () => {
    const item = mapMRToWorkItem({ iid: 1, title: 't', state: 'opened' }, 'g/p')
    expect(item.isCrossRepository).toBe(false)
  })

  it('infers draft from a Draft: title prefix', () => {
    const item = mapMRToWorkItem({ iid: 1, title: 'Draft: WIP refactor', state: 'opened' }, 'g/p')
    expect(item.state).toBe('draft')
  })

  it('falls back to a deterministic id when GitLab omits global id', () => {
    // Why: the GitLab list endpoint always returns id, but the per-MR
    // detail endpoint occasionally omits it on older instances. The
    // fallback keeps unique-per-(repo,iid) without colliding with other
    // MRs in the picker.
    const item = mapMRToWorkItem({ iid: 5, title: 't', state: 'opened' }, 'g/p')
    expect(item.id).toBe('gitlab-mr-g/p-5')
  })
})

describe('mapIssueToWorkItem', () => {
  it('coerces opened/closed and produces a unified GitLabWorkItem', () => {
    expect(
      mapIssueToWorkItem(
        {
          id: 200,
          iid: 9,
          title: 'bug',
          state: 'opened',
          web_url: 'https://gitlab.com/g/p/-/issues/9',
          updated_at: '2026-05-05T10:00:00Z',
          author: { username: 'alice' },
          labels: ['bug']
        },
        'g/p'
      )
    ).toEqual({
      id: 'gitlab-issue-200',
      type: 'issue',
      number: 9,
      title: 'bug',
      state: 'opened',
      url: 'https://gitlab.com/g/p/-/issues/9',
      labels: ['bug'],
      updatedAt: '2026-05-05T10:00:00Z',
      author: 'alice',
      repoId: 'g/p'
    })
  })

  it("collapses any non-'opened' state to 'closed'", () => {
    expect(mapIssueToWorkItem({ iid: 1, title: 't', state: 'closed' }, 'g/p').state).toBe('closed')
    // Defensive: a future state we don't recognize must not leak
    // through as a 'merged' or 'draft' value.
    expect(mapIssueToWorkItem({ iid: 1, title: 't', state: 'weird' }, 'g/p').state).toBe('closed')
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
