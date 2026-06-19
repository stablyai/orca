import { describe, expect, it } from 'vitest'
import { mapIssueToWorkItem, mapMRToWorkItem } from './mappers'

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
