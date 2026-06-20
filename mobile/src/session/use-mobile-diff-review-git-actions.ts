import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { GitMutationMethod } from './mobile-diff-review-screen-model'
import { mobileReviewCountLabel } from './mobile-diff-review-screen-model'

type GitActionsInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  queue: MobileDiffReviewQueueItem[]
  setActionError: Dispatch<SetStateAction<string | null>>
  setBusyAction: Dispatch<SetStateAction<string | null>>
  loadReviewData: () => Promise<void>
}

export function useMobileDiffReviewGitActions(input: GitActionsInput) {
  const { client, connState, worktreeId, queue, setActionError, setBusyAction, loadReviewData } =
    input

  const runGitMutation = useCallback(
    async (method: GitMutationMethod, item: MobileDiffReviewQueueItem) => {
      if (!client || connState !== 'connected') {
        setActionError('Waiting for desktop...')
        return
      }
      setBusyAction(`${method}:${item.filePath}`)
      setActionError(null)
      try {
        const response = await client.sendRequest(method, {
          worktree: `id:${worktreeId}`,
          filePath: item.filePath
        })
        if (!response.ok) {
          throw new Error(response.error?.message || 'Source control action failed')
        }
        triggerSuccess()
        await loadReviewData()
      } catch (err) {
        triggerError()
        setActionError(err instanceof Error ? err.message : 'Source control action failed')
      } finally {
        setBusyAction(null)
      }
    },
    [client, connState, loadReviewData, setActionError, setBusyAction, worktreeId]
  )

  const stageReviewedFiles = useCallback(async () => {
    if (!client || connState !== 'connected') {
      setActionError('Waiting for desktop...')
      return
    }
    const files = queue.filter(
      (item) => item.scope === 'unstaged' && item.isReviewed && item.canStage
    )
    if (files.length === 0) {
      return
    }
    setBusyAction('stage-reviewed')
    setActionError(null)
    let staged = 0
    let failed = 0
    for (const item of files) {
      const response = await client.sendRequest('git.stage', {
        worktree: `id:${worktreeId}`,
        filePath: item.filePath
      })
      if (response.ok) {
        staged += 1
      } else {
        failed += 1
      }
    }
    setBusyAction(null)
    triggerSuccess()
    setActionError(
      failed > 0
        ? `${staged} staged, ${failed} failed`
        : `${mobileReviewCountLabel(staged, 'reviewed file', 'reviewed files')} staged`
    )
    await loadReviewData()
  }, [client, connState, loadReviewData, queue, setActionError, setBusyAction, worktreeId])

  return { runGitMutation, stageReviewedFiles }
}
