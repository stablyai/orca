// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitLabWorkItem, GitLabWorkItemDetails } from '../../../shared/gitlab-types'
import type { TaskSourceContext } from '../../../shared/work-items/task-source-context'
import GitLabItemDialog from './GitLabItemDialog'

const api = vi.hoisted(() => ({
  workItemDetails: vi.fn(),
  mergeMR: vi.fn(),
  closeMR: vi.fn(),
  updateMR: vi.fn(),
  updateMRReviewers: vi.fn(),
  listLabels: vi.fn()
}))
vi.mock('@/runtime/repository-gitlab/gitlab-owner-api', () => ({ gitLabApiFor: () => api }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function mr(number: number, state: GitLabWorkItem['state'] = 'opened'): GitLabWorkItem {
  return {
    id: `gitlab-mr-${number}`,
    type: 'mr',
    number,
    title: `MR ${number}`,
    state,
    url: `https://gitlab.example.test/g/p/-/merge_requests/${number}`,
    labels: [],
    updatedAt: '2026-11-01',
    author: null,
    repoId: 'repo-1'
  }
}
function detailsFor(item: GitLabWorkItem, reviewer: string): GitLabWorkItemDetails {
  return {
    item,
    body: '',
    comments: [],
    reviewers: [{ id: 1, username: reviewer, name: reviewer, avatarUrl: '' }]
  }
}

function renderDialog(item: GitLabWorkItem) {
  return render(<GitLabItemDialog item={item} repoPath="/repo" repoId="repo-1" onClose={vi.fn()} />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('GitLabItemDialog reconciliation', () => {
  it('drops the previous MR details when another MR opens', async () => {
    api.workItemDetails.mockResolvedValueOnce(detailsFor(mr(7), 'alice'))
    const view = renderDialog(mr(7))
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())

    api.workItemDetails.mockReturnValueOnce(new Promise(() => {}))
    view.rerender(
      <GitLabItemDialog item={mr(8)} repoPath="/repo" repoId="repo-1" onClose={vi.fn()} />
    )

    expect(screen.queryByText('alice')).toBeNull()
    expect(screen.queryByText('Reviewers')).toBeNull()
  })

  it('drops the previous source details when only the task source changes', async () => {
    const source: TaskSourceContext = {
      kind: 'task-source',
      provider: 'gitlab',
      projectId: 'p',
      hostId: 'runtime:server',
      repoId: 'a'
    }
    api.workItemDetails.mockResolvedValueOnce(detailsFor(mr(7, 'merged'), 'alice'))
    const view = render(
      <GitLabItemDialog
        item={mr(7)}
        repoPath="/repo"
        repoId="repo-1"
        sourceContext={source}
        onClose={vi.fn()}
      />
    )
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull()

    // Same item id, IID, repo, path and execution host; only the routed source repo differs.
    api.workItemDetails.mockReturnValueOnce(new Promise(() => {}))
    view.rerender(
      <GitLabItemDialog
        item={mr(7)}
        repoPath="/repo"
        repoId="repo-1"
        sourceContext={{ ...source, repoId: 'b' }}
        onClose={vi.fn()}
      />
    )

    expect(screen.queryByText('alice')).toBeNull()
    expect(screen.getByRole('button', { name: 'Merge' })).toBeTruthy()
  })
})
