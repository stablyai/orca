import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import { useMobileDiffReviewGitActions } from './use-mobile-diff-review-git-actions'

vi.mock('../platform/haptics', () => ({ triggerSuccess: vi.fn(), triggerError: vi.fn() }))

const RENAMED_STAGED: MobileDiffReviewQueueItem = {
  key: 'staged:after.txt',
  scope: 'staged',
  area: 'staged',
  filePath: 'after.txt',
  oldPath: 'before.txt',
  status: 'renamed',
  title: 'after.txt',
  subtitle: '',
  canStage: false,
  canUnstage: true,
  canDiscard: false,
  isGeneratedOrLockFile: false,
  diffIdentity: 'id',
  noteCount: 0,
  unsentNoteCount: 0,
  staleNoteCount: 0,
  isReviewed: false,
  changedSinceReview: false
}

describe('useMobileDiffReviewGitActions', () => {
  it('unstages both sides of a staged rename in one bulk request', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (): Promise<RpcResponse> => ({
      id: 'rpc',
      ok: true,
      result: {},
      _meta: { runtimeId: 'r' }
    }))
    const client: RpcClient = {
      sendRequest,
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    const setActionError = vi.fn()
    let actions: ReturnType<typeof useMobileDiffReviewGitActions> | null = null
    function Probe() {
      actions = useMobileDiffReviewGitActions({
        client,
        connState: 'connected',
        worktreeId: 'wt-1',
        queue: [RENAMED_STAGED],
        setActionError,
        setBusyAction: () => {},
        loadReviewData: async () => {}
      })
      return null
    }
    await act(async () => {
      create(createElement(Probe))
    })

    await act(async () => {
      await actions?.runGitMutation('git.unstage', RENAMED_STAGED)
    })

    expect(sendRequest.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ['git.bulkUnstage', { worktree: 'id:wt-1', filePaths: ['after.txt', 'before.txt'] }]
    ])
    expect(setActionError).not.toHaveBeenCalledWith(expect.any(String))
  })
})
