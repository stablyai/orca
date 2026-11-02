// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitLabWorkItem, GitLabWorkItemDetails } from '../../../shared/gitlab-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import GitLabItemDialog from './GitLabItemDialog'

const api = vi.hoisted(() => ({
  workItemDetails: vi.fn(),
  mergeMR: vi.fn(),
  closeMR: vi.fn(),
  updateMR: vi.fn(),
  updateMRReviewers: vi.fn(),
  listLabels: vi.fn()
}))
vi.mock('@/runtime/gitlab-owner-api', () => ({ gitLabApiFor: () => api }))
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
  it('follows a reread that shows a failed merge landed, keeping Reviewers mounted while it runs', async () => {
    const item = mr(7)
    api.workItemDetails.mockResolvedValueOnce(detailsFor(item, 'alice'))
    renderDialog(item)
    await waitFor(() => expect(screen.getByText('Reviewers')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Merge' })).toBeTruthy()
    // The sheet's own close control shares the name, so the MR's Close button is the second.
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2)

    const reread = Promise.withResolvers<GitLabWorkItemDetails | null>()
    api.workItemDetails.mockReturnValueOnce(reread.promise)
    api.mergeMR.mockResolvedValueOnce({ ok: false, error: 'Connection lost' })
    await act(async () => screen.getByRole('button', { name: 'Merge' }).click())

    // The reread is pending: loaded content stays, including the Reviewers section.
    expect(api.workItemDetails).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Reviewers')).toBeTruthy()
    await act(async () => reread.resolve(detailsFor(mr(7, 'merged'), 'alice')))

    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1)
    expect(screen.getByText('merged')).toBeTruthy()
  })

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

  // A write that settles after the dialog moved to another MR must not reread or release state for the new one.
  it.each(['save', 'reviewer', 'close', 'merge'] as const)(
    'keeps the next MR first read and controls when a %s on the previous MR fails after switching',
    async (action) => {
      api.workItemDetails.mockResolvedValueOnce(detailsFor(mr(7), 'alice'))
      api.listLabels.mockResolvedValue([])
      const write = Promise.withResolvers<{ ok: false; error: string }>()
      api.updateMR.mockReturnValueOnce(write.promise)
      api.updateMRReviewers.mockReturnValueOnce(write.promise)
      api.closeMR.mockReturnValueOnce(write.promise)
      api.mergeMR.mockReturnValueOnce(write.promise)
      const view = renderDialog(mr(7))
      await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())

      if (action === 'save') {
        fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!)
        fireEvent.change(screen.getByDisplayValue('MR 7'), { target: { value: 'Renamed' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      } else if (action === 'reviewer') {
        fireEvent.click(screen.getByRole('button', { name: 'Remove reviewer alice' }))
      } else if (action === 'close') {
        // The sheet's own close control shares the name, so the MR's Close button is the second.
        fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[1]!)
      } else {
        fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
      }
      const nextRead = Promise.withResolvers<GitLabWorkItemDetails | null>()
      api.workItemDetails.mockReturnValueOnce(nextRead.promise)
      view.rerender(
        <GitLabItemDialog item={mr(8)} repoPath="/repo" repoId="repo-1" onClose={vi.fn()} />
      )
      await act(async () => write.resolve({ ok: false, error: 'Connection lost' }))
      await act(async () => nextRead.resolve(detailsFor(mr(8), 'bob')))

      expect(api.workItemDetails).toHaveBeenCalledTimes(2)
      expect(screen.getByText('bob')).toBeTruthy()
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Remove reviewer bob' }).disabled
      ).toBe(false)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Merge' }).disabled).toBe(false)
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!)
      expect(screen.getByDisplayValue<HTMLInputElement>('MR 8').disabled).toBe(false)
    }
  )
})
