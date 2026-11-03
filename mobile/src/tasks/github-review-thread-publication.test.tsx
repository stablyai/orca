import React, { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { githubTaskKey, useMobileTasksSelection } from './github-task-identity'
import { item } from './github-task-identity.test-fixture'
import type { DetailPayload } from './mobile-tasks-provider-detail-types'
import { useMobileTasksGithubCheckFileActions } from './use-mobile-tasks-github-check-file-actions'
import { useMobileTasksMutation } from './use-mobile-tasks-workspace-and-project-state'

vi.mock('./mobile-tasks-dependencies', async () => import('react'))
vi.mock('./mobile-tasks-legacy-foundation', () => ({ EMPTY_GITHUB_PROJECT_SETTINGS: {} }))

const noop = () => {}

it('publishes review-thread changes only into the accepted detail revision', async () => {
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
    const actions = useMobileTasksGithubCheckFileActions({
      ...selection,
      ...mutation,
      client,
      detailPayload,
      expandedPrFilePath: null,
      prFileCommentDrafts: {},
      prFileContents: {},
      setDetailPayload,
      setDetailRefreshSeq: noop,
      setError: noop,
      setExpandedPrFilePath: noop,
      setPrFileCommentDrafts: noop,
      setPrFileContents: noop,
      beginFileLoad: () => {
        throw new Error('No file read in this test')
      }
    })
    return { ...selection, ...mutation, ...actions, detailPayload, setDetailPayload }
  }
  function Probe() {
    current = useModel()
    return null
  }
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<Probe />)
  })
  try {
    await act(async () => {
      current.setActionItem(selected)
      current.setDetailPayload(details)
    })
    let pending!: Promise<void>
    await act(async () => {
      pending = current.toggleGitHubReviewThread(selected, comment)
    })
    await act(async () => {
      current.setDetailPayload({ ...details, headSha: 'new-head' })
    })
    await act(async () => client.requests[0].resolve(rpcSuccess('old', true)))
    await pending
    expect(current.detailPayload?.comments).toEqual([comment])
    expect(current.mutatingStatus).toBe(false)
    await act(async () => {
      pending = current.toggleGitHubReviewThread(selected, comment)
    })
    await act(async () => client.requests[1].resolve(rpcSuccess('fresh', true)))
    await pending
    expect(current.detailPayload?.comments).toEqual([{ ...comment, isResolved: true }])
    expect(current.mutatingStatus).toBe(false)
  } finally {
    await act(async () => renderer.unmount())
  }
})
