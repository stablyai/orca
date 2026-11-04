import React, { useLayoutEffect, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { githubTaskKey, useMobileTasksSelection } from './github-task-identity'
import { item } from './github-task-identity.test-fixture'
import type { DetailPayload, GitHubDetailFile } from './mobile-tasks-provider-detail-types'
import { useMobileTasksGithubCheckFileActions } from './use-mobile-tasks-github-check-file-actions'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import { buildGitHubCheckSummary } from './github-check-summary'
import { useMobileTasksHostedCommentReviewActions } from './use-mobile-tasks-hosted-comment-review-actions'
import { useMobileTasksMutation } from './use-mobile-tasks-workspace-and-project-state'
import { useMobileTasksItemState } from './use-mobile-tasks-item-state'
import { useMobileTasksItemDetailLoading } from './use-mobile-tasks-item-detail-loading'

vi.mock('./mobile-tasks-dependencies', async () => ({
  ...(await import('react')),
  ...(await import('./github-check-summary')),
  scheduleMobileTaskCopyFeedbackReset: () => {}
}))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText: vi.fn() }) }))
vi.mock('./mobile-tasks-legacy-foundation', () => ({
  EMPTY_GITHUB_PROJECT_SETTINGS: {},
  splitReviewerList: () => [],
  groupDetailComments: () => []
}))

async function mount(loadDetails = false) {
  const client = createFakeRpcClient()
  const selected = item('fork')
  const comment = { id: 5, body: 'parent', author: 'me', createdAt: '', threadId: 'thread' }
  const file = {
    path: 'same.ts',
    additions: 1,
    deletions: 0,
    status: 'modified',
    viewerViewedState: 'UNVIEWED' as const
  } satisfies GitHubDetailFile
  const details: Extract<DetailPayload, { provider: 'github' }> = {
    provider: 'github',
    targetKey: githubTaskKey(selected.source),
    body: '',
    labels: [],
    assignees: [],
    comments: [comment],
    reviewRequests: [],
    latestReviews: [],
    files: [file],
    checks: [],
    pullRequestId: 'PR_fork',
    headSha: 'old-head',
    baseSha: 'base'
  }
  const commits: (DetailPayload | null)[] = []
  let current!: ReturnType<typeof useModel>
  function useModel() {
    const itemState = useMobileTasksItemState()
    const selection = useMobileTasksSelection(
      client,
      itemState.readDetailPayload,
      itemState.reconcilePrFileConnection
    )
    const mutation = useMobileTasksMutation()
    const [items, setItems] = useState<TaskItem[]>([selected])
    const [error, setError] = useState('')
    useLayoutEffect(() => {
      commits.push(itemState.detailPayload)
    }, [itemState.detailPayload])
    const model = {
      ...selection,
      ...mutation,
      ...itemState,
      client,
      tasksSupported: true,
      setError,
      items,
      setItems
    }
    const actions = useMobileTasksGithubCheckFileActions(
      useMobileTasksHostedCommentReviewActions(model)
    )
    return { ...actions, error }
  }
  function Probe() {
    current = useModel()
    return loadDetails ? <LoadDetails /> : null
  }
  function LoadDetails() {
    useMobileTasksItemDetailLoading(current)
    return null
  }
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<Probe />)
  })
  await act(async () => {
    current.setActionItem(selected)
    if (!loadDetails) {
      current.setDetailPayload(details)
    }
  })
  if (loadDetails) {
    await act(async () => client.requests[0].resolve(rpcSuccess('status', { capabilities: [] })))
    await act(async () =>
      client.requests[1].resolve(rpcSuccess('details', { ...details, item: selected.source }))
    )
  }
  return { client, selected, comment, file, details, read: () => current, renderer, commits }
}

it('retires old thread feedback before a queued detail revision commits and composes current updates', async () => {
  const f = await mount()
  try {
    let pending!: Promise<void>
    await act(async () => {
      pending = f.read().toggleGitHubReviewThread(f.selected, f.comment)
    })
    await act(async () => {
      f.read().setDetailPayload({ ...f.details, headSha: 'new-head' })
      f.read().setDetailPayload((value) =>
        value?.provider === 'github' ? { ...value, body: `${value.body}first` } : value
      )
      f.read().setDetailPayload((value) =>
        value?.provider === 'github' ? { ...value, body: `${value.body}+second` } : value
      )
      f.client.requests[0].resolve(rpcSuccess('old', true))
      await pending
      expect(f.commits.at(-1)).toMatchObject({ headSha: 'old-head' })
    })
    expect(f.read().detailPayload).toMatchObject({ headSha: 'new-head', body: 'first+second' })
    expect(f.read().detailPayload?.comments).toEqual([f.comment])
    expect(f.read().mutatingStatus).toBe(false)
    await act(async () => {
      pending = f.read().toggleGitHubReviewThread(f.selected, f.comment)
    })
    await act(async () => f.client.requests[1].resolve(rpcSuccess('fresh', true)))
    await pending
    expect(f.read().detailPayload?.comments).toEqual([{ ...f.comment, isResolved: true }])
    expect(f.read().mutatingStatus).toBe(false)
  } finally {
    await act(async () => f.renderer.unmount())
  }
})

it.each(['success', 'error'] as const)(
  'suppresses queued-revision checks-refresh %s across every feedback output and admits a fresh refresh',
  async (outcome) => {
    const f = await mount()
    const newerChecks = [{ name: 'newer', status: 'completed', conclusion: 'success' }]
    const newerSummary = buildGitHubCheckSummary(newerChecks)
    const revision = outcome === 'error' ? { baseSha: 'new-base' } : { headSha: 'new-head' }
    try {
      let pending!: Promise<void>
      await act(async () => {
        pending = f.read().refreshGitHubChecks(f.selected)
      })
      await act(async () => {
        f.read().setDetailPayload({ ...f.details, ...revision, checks: newerChecks })
        const newerItem = {
          ...f.selected,
          source: { ...f.selected.source, checksSummary: newerSummary }
        }
        f.read().setActionItem(newerItem)
        f.read().setItems([newerItem])
        if (outcome === 'error') {
          f.client.requests[0].reject(new Error('old failure'))
        } else {
          f.client.requests[0].resolve(rpcSuccess('old', [{ name: 'old', status: 'queued' }]))
        }
        await pending
        expect(f.commits.at(-1)).toMatchObject({ headSha: 'old-head', baseSha: 'base' })
      })
      expect(f.read()).toMatchObject({
        detailPayload: { ...revision, checks: newerChecks },
        actionItem: { source: { checksSummary: newerSummary } },
        items: [{ source: { checksSummary: newerSummary } }],
        error: '',
        mutatingStatus: false
      })
      const freshChecks = [{ name: 'fresh', status: 'in_progress' }]
      await act(async () => {
        pending = f.read().refreshGitHubChecks(f.selected)
      })
      await act(async () => f.client.requests[1].resolve(rpcSuccess('fresh', freshChecks)))
      await pending
      const freshSummary = buildGitHubCheckSummary(freshChecks)
      expect(f.read()).toMatchObject({
        detailPayload: { ...revision, checks: freshChecks },
        actionItem: { source: { checksSummary: freshSummary } },
        items: [{ source: { checksSummary: freshSummary } }],
        error: '',
        mutatingStatus: false
      })
    } finally {
      await act(async () => f.renderer.unmount())
    }
  }
)

it.each(['viewed', 'comment'] as const)(
  'keeps queued revision files and drafts after an obsolete %s reply, then accepts fresh success',
  async (action) => {
    const f = await mount()
    const draftKey = `${f.file.path}:1`
    try {
      await act(async () => f.read().setPrFileCommentDrafts({ [draftKey]: 'first draft' }))
      const invoke = () =>
        action === 'viewed'
          ? f.read().toggleGitHubFileViewed(f.selected, f.file)
          : f.read().addGitHubFileReviewComment(f.selected, f.file, 1)
      const reply = action === 'viewed' ? true : { ok: true, comment: { ...f.comment, id: 6 } }
      let pending!: Promise<void>
      await act(async () => {
        pending = invoke()
      })
      await act(async () => {
        f.read().setDetailPayload({ ...f.details, headSha: 'new-head' })
        f.read().setPrFileCommentDrafts({ [draftKey]: 'new draft' })
        f.client.requests[0].resolve(rpcSuccess('old', reply))
        await pending
        expect(f.commits.at(-1)).toMatchObject({ headSha: 'old-head' })
      })
      expect(f.read()).toMatchObject({
        detailPayload: { headSha: 'new-head', files: [f.file], comments: [f.comment] },
        prFileCommentDrafts: { [draftKey]: 'new draft' },
        error: '',
        mutatingStatus: false
      })
      await act(async () => {
        pending = invoke()
      })
      await act(async () => f.client.requests[1].resolve(rpcSuccess('fresh', reply)))
      await pending
      expect(f.read().mutatingStatus).toBe(false)
      if (action === 'viewed') {
        expect(f.read().detailPayload).toMatchObject({ files: [{ viewerViewedState: 'VIEWED' }] })
      } else {
        expect(f.read().prFileCommentDrafts).toEqual({})
        expect(f.read().detailPayload?.comments).toHaveLength(2)
      }
    } finally {
      await act(async () => f.renderer.unmount())
    }
  }
)

it.each(['success', 'error'] as const)(
  'suppresses file %s before a queued revision commits and permits a fresh file read',
  async (outcome) => {
    const f = await mount()
    try {
      let pending!: Promise<void>
      await act(async () => {
        pending = f.read().toggleGitHubFileExpansion(f.selected, f.file)
      })
      await act(async () => {
        f.read().setDetailPayload({ ...f.details, headSha: 'new-head' })
        if (outcome === 'error') {
          f.client.requests[0].reject(new Error('obsolete file error'))
        } else {
          f.client.requests[0].resolve(rpcSuccess('old', { original: 'old', modified: 'old' }))
        }
        await pending
        expect(f.commits.at(-1)).toMatchObject({ headSha: 'old-head' })
      })
      expect(f.read()).toMatchObject({ prFileContents: {}, prFileLoadingPath: null, error: '' })
      await act(async () => f.read().toggleGitHubFileExpansion(f.selected, f.file))
      await act(async () => {
        pending = f.read().toggleGitHubFileExpansion(f.selected, f.file)
      })
      await act(async () =>
        f.client.requests[1].resolve(rpcSuccess('fresh', { original: 'fresh', modified: 'fresh' }))
      )
      await pending
      expect(f.read()).toMatchObject({
        prFileContents: { [f.file.path]: { original: 'fresh', modified: 'fresh' } },
        prFileLoadingPath: null
      })
    } finally {
      await act(async () => f.renderer.unmount())
    }
  }
)

it('refreshes through the real loader and records its reset/commit order around a held action', async () => {
  const f = await mount(true)
  try {
    let pending!: Promise<void>
    await act(async () => {
      pending = f.read().toggleGitHubReviewThread(f.selected, f.comment)
    })
    await act(async () => f.read().requestDetailRefresh())
    expect(f.read().detailPayload).toBeNull()
    expect(f.read().readDetailPayload()).toBeNull()
    await act(async () => f.client.requests[3].resolve(rpcSuccess('status', { capabilities: [] })))
    expect(f.client.requests.map((request) => request.method)).toEqual([
      'status.get',
      'github.workItemDetails',
      'github.resolveReviewThread',
      'status.get',
      'github.workItemDetails'
    ])
    await act(async () => {
      f.client.requests[4].resolve(
        rpcSuccess('details', { ...f.details, headSha: 'new-head', item: f.selected.source })
      )
      f.client.requests[2].resolve(rpcSuccess('old', true))
      await pending
    })
    expect(f.read()).toMatchObject({
      detailPayload: { headSha: 'new-head', comments: [f.comment] },
      detailLoading: false,
      mutatingStatus: false
    })
    expect(f.commits.map((value) => (value?.provider === 'github' ? value.headSha : null))).toEqual(
      [null, 'old-head', null, 'new-head']
    )
    await act(async () => {
      pending = f.read().toggleGitHubReviewThread(f.selected, f.comment)
    })
    await act(async () => f.client.requests[5].resolve(rpcSuccess('fresh', true)))
    await pending
    expect(f.read().detailPayload?.comments[0].isResolved).toBe(true)
  } finally {
    await act(async () => f.renderer.unmount())
  }
})
