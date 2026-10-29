import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { translate } from '../i18n/mobile-i18n'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import {
  MOBILE_DIFF_REVIEW_GIT_MUTATIONS,
  reviewGitStageRun
} from './mobile-diff-review-git-operations'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { GitMutationMethod } from './mobile-diff-review-screen-model'

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
        setActionError(
          translate('session.useDiffReviewGitActions.waitingForDesktop', 'Waiting for desktop...')
        )
        return
      }
      setBusyAction(`${method}:${item.filePath}`)
      setActionError(null)
      try {
        const mutation = MOBILE_DIFF_REVIEW_GIT_MUTATIONS[method]
        const response = await mutation.request(client, {
          worktree: `id:${worktreeId}`,
          filePath: item.filePath
        })
        interpretOrThrowRefusalMessage(
          () => mutation.interpret(response),
          translate('session.useDiffReviewGitActions.actionFailed', 'Source control action failed')
        )
        triggerSuccess()
        await loadReviewData()
      } catch (err) {
        triggerError()
        setActionError(
          err instanceof Error
            ? err.message
            : translate(
                'session.useDiffReviewGitActions.actionFailed',
                'Source control action failed'
              )
        )
      } finally {
        setBusyAction(null)
      }
    },
    [client, connState, loadReviewData, setActionError, setBusyAction, worktreeId]
  )

  const stageReviewedFiles = useCallback(async () => {
    if (!client || connState !== 'connected') {
      setActionError(
        translate('session.useDiffReviewGitActions.waitingForDesktop', 'Waiting for desktop...')
      )
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
      const response = reviewGitStageRun.interpret(
        await reviewGitStageRun.request(client, {
          worktree: `id:${worktreeId}`,
          filePath: item.filePath
        })
      )
      if (response.accepted) {
        staged += 1
      } else {
        failed += 1
      }
    }
    setBusyAction(null)
    triggerSuccess()
    const count = staged
    setActionError(
      failed > 0
        ? translate(
            'session.useDiffReviewGitActions.stageResults',
            '{{staged}} staged, {{failed}} failed',
            {
              staged,
              failed
            }
          )
        : count === 1
          ? translate(
              'session.useDiffReviewGitActions.reviewedFilesStaged_one',
              '{{count}} reviewed file staged',
              { count }
            )
          : translate(
              'session.useDiffReviewGitActions.reviewedFilesStaged_other',
              '{{count}} reviewed files staged',
              { count }
            )
    )
    await loadReviewData()
  }, [client, connState, loadReviewData, queue, setActionError, setBusyAction, worktreeId])

  return { runGitMutation, stageReviewedFiles }
}
