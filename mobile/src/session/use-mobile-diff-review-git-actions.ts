import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
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

type BulkStageGenerationClient = RpcClient & {
  getGeneration?: () => number
}

type StageReviewedResult = { staged: number; failed: number }

// Why: reconnecting can replace an upgraded host behind the same logical client.
const unsupportedBulkStageGeneration = new WeakMap<RpcClient, string>()

function readBulkStageGeneration(client: RpcClient): string {
  const generationClient = client as BulkStageGenerationClient
  return `${generationClient.getGeneration?.() ?? 0}:${generationClient.getLastConnectedAt() ?? 0}`
}

async function stageReviewedFilePaths(
  client: RpcClient,
  worktreeId: string,
  filePaths: readonly string[]
): Promise<StageReviewedResult> {
  const generation = readBulkStageGeneration(client)
  if (unsupportedBulkStageGeneration.get(client) !== generation) {
    const response = await client.sendRequest('git.bulkStage', {
      worktree: `id:${worktreeId}`,
      filePaths
    })
    if (response.ok) {
      return { staged: filePaths.length, failed: 0 }
    }
    // Why: any other failure may follow a partial bulk mutation, so status must be refreshed.
    if (response.error.code !== 'method_not_found') {
      throw new Error(response.error.message || 'Source control action failed')
    }
    if (readBulkStageGeneration(client) === generation) {
      unsupportedBulkStageGeneration.set(client, generation)
    }
  }

  let staged = 0
  let failed = 0
  for (const filePath of filePaths) {
    const response = await client.sendRequest('git.stage', {
      worktree: `id:${worktreeId}`,
      filePath
    })
    if (response.ok) {
      staged += 1
    } else {
      failed += 1
    }
  }
  return { staged, failed }
}

export function useMobileDiffReviewGitActions(input: GitActionsInput) {
  const { client, connState, worktreeId, queue, setActionError, setBusyAction, loadReviewData } =
    input
  const stageReviewedInFlightRef = useRef(false)

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
    if (stageReviewedInFlightRef.current) {
      return
    }
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
    stageReviewedInFlightRef.current = true
    setBusyAction('stage-reviewed')
    setActionError(null)
    try {
      const { staged, failed } = await stageReviewedFilePaths(
        client,
        worktreeId,
        files.map((item) => item.filePath)
      )
      triggerSuccess()
      setActionError(
        failed > 0
          ? `${staged} staged, ${failed} failed`
          : `${mobileReviewCountLabel(staged, 'reviewed file', 'reviewed files')} staged`
      )
    } catch (err) {
      triggerError()
      setActionError(err instanceof Error ? err.message : 'Source control action failed')
    } finally {
      try {
        await loadReviewData()
      } finally {
        stageReviewedInFlightRef.current = false
        setBusyAction(null)
      }
    }
  }, [client, connState, loadReviewData, queue, setActionError, setBusyAction, worktreeId])

  return { runGitMutation, stageReviewedFiles }
}
