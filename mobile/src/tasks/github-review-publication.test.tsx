import React, { useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { githubTaskKey, useMobileTasksSelection } from './github-task-identity'
import { item } from './github-task-identity.test-fixture'
import type { DetailPayload } from './mobile-tasks-provider-detail-types'
import { useMobileTasksGithubCheckFileActions } from './use-mobile-tasks-github-check-file-actions'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import { buildGitHubCheckSummary } from './github-check-summary'
import { useMobileTasksHostedCommentReviewActions } from './use-mobile-tasks-hosted-comment-review-actions'
import { useMobileTasksMutation } from './use-mobile-tasks-workspace-and-project-state'

vi.mock('./mobile-tasks-dependencies', async () => ({
  ...(await import('react')),
  ...(await import('./github-check-summary')),
  scheduleMobileTaskCopyFeedbackReset: () => {}
}))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText: vi.fn() }) }))
vi.mock('./mobile-tasks-legacy-foundation', () => ({
  EMPTY_GITHUB_PROJECT_SETTINGS: {},
  splitReviewerList: () => []
}))

const noop = () => {}

async function mount() {
  const client = createFakeRpcClient()
  const selected = item('fork')
  const comment = { id: 5, body: 'parent', author: 'me', createdAt: '', threadId: 'thread' }
  const details: Extract<DetailPayload, { provider: 'github' }> = {
    provider: 'github',
    targetKey: githubTaskKey(selected.source),
    body: '',
    labels: [],
    assignees: [],
    comments: [comment],
    reviewRequests: [],
    latestReviews: [],
    files: [],
    checks: [],
    headSha: 'old-head',
    baseSha: 'base'
  }
  let current!: ReturnType<typeof useModel>
  function useModel() {
    const [detailPayload, setDetailPayload] = useState<DetailPayload | null>(null)
    const selection = useMobileTasksSelection(client, detailPayload, noop)
    const mutation = useMobileTasksMutation()
    const [items, setItems] = useState<TaskItem[]>([selected])
    const [error, setError] = useState('')
    const copiedLinkResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const model = {
      ...selection,
      ...mutation,
      client,
      detailPayload,
      expandedPrFilePath: null,
      prFileCommentDrafts: {},
      prFileContents: {},
      setDetailPayload,
      setDetailRefreshSeq: noop,
      setError,
      items,
      setItems,
      copiedLinkResetTimerRef,
      itemCommentDraft: '',
      itemReviewersDraft: '',
      setCopiedLinkKey: noop,
      setItemCommentDraft: noop,
      setItemReviewersDraft: noop,
      setExpandedPrFilePath: noop,
      setPrFileCommentDrafts: noop,
      setPrFileContents: noop,
      beginFileLoad: () => {
        throw new Error('No file read in this test')
      }
    }
    const actions = useMobileTasksGithubCheckFileActions(
      useMobileTasksHostedCommentReviewActions(model)
    )
    return { ...actions, error }
  }
  function Probe() {
    current = useModel()
    return null
  }
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<Probe />)
  })
  await act(async () => {
    current.setActionItem(selected)
    current.setDetailPayload(details)
  })
  return { client, selected, comment, details, read: () => current, renderer }
}

it('publishes review-thread changes only into the accepted detail revision', async () => {
  const f = await mount()
  try {
    let pending!: Promise<void>
    await act(async () => {
      pending = f.read().toggleGitHubReviewThread(f.selected, f.comment)
    })
    await act(async () => {
      f.read().setDetailPayload({ ...f.details, headSha: 'new-head' })
    })
    await act(async () => f.client.requests[0].resolve(rpcSuccess('old', true)))
    await pending
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
  'suppresses old-head checks-refresh %s and admits a fresh refresh',
  async (outcome) => {
    const f = await mount()
    const newerChecks = [{ name: 'newer', status: 'completed', conclusion: 'success' }]
    const newerSummary = buildGitHubCheckSummary(newerChecks)
    try {
      let pending!: Promise<void>
      await act(async () => {
        pending = f.read().refreshGitHubChecks(f.selected)
      })
      await act(async () => {
        f.read().setDetailPayload({ ...f.details, headSha: 'new-head', checks: newerChecks })
        const newerItem = {
          ...f.selected,
          source: { ...f.selected.source, checksSummary: newerSummary }
        }
        f.read().setActionItem(newerItem)
        f.read().setItems([newerItem])
      })
      await act(async () => {
        if (outcome === 'error') {
          f.client.requests[0].reject(new Error('old failure'))
        } else {
          f.client.requests[0].resolve(rpcSuccess('old', [{ name: 'old', status: 'queued' }]))
        }
      })
      await pending
      expect(f.read()).toMatchObject({
        detailPayload: { headSha: 'new-head', checks: newerChecks },
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
        detailPayload: { headSha: 'new-head', checks: freshChecks },
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
