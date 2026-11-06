import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { translate } from '../i18n/mobile-i18n'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import {
  MOBILE_DIFF_REVIEW_GIT_MUTATIONS,
  reviewGitBulkUnstage
} from './mobile-diff-review-git-operations'
import { getUnstageablePaths } from '../source-control/mobile-git-status'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { GitMutationMethod } from './mobile-diff-review-screen-model'

type GitActionsInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  setActionError: Dispatch<SetStateAction<string | null>>
  setBusyAction: Dispatch<SetStateAction<string | null>>
  loadReviewData: () => Promise<void>
}

export function useMobileDiffReviewGitActions(input: GitActionsInput) {
  const { client, connState, worktreeId, setActionError, setBusyAction, loadReviewData } = input

  const runGitMutation = useCallback(
    // Resolves whether the mutation landed, so callers can move on only after it did.
    async (method: GitMutationMethod, item: MobileDiffReviewQueueItem): Promise<boolean> => {
      if (!client || connState !== 'connected') {
        setActionError(
          translate('session.useDiffReviewGitActions.waitingForDesktop', 'Waiting for desktop...')
        )
        return false
      }
      setBusyAction(`${method}:${item.filePath}`)
      setActionError(null)
      try {
        const failureMessage = translate(
          'session.useDiffReviewGitActions.actionFailed',
          'Source control action failed'
        )
        const filePaths =
          method === 'git.unstage' && item.area === 'staged'
            ? getUnstageablePaths([
                { path: item.filePath, oldPath: item.oldPath, status: item.status, area: item.area }
              ])
            : []
        if (filePaths.length > 1) {
          const response = await reviewGitBulkUnstage.request(client, {
            worktree: `id:${worktreeId}`,
            filePaths
          })
          interpretOrThrowRefusalMessage(
            () => reviewGitBulkUnstage.interpret(response),
            failureMessage
          )
        } else {
          const mutation = MOBILE_DIFF_REVIEW_GIT_MUTATIONS[method]
          const response = await mutation.request(client, {
            worktree: `id:${worktreeId}`,
            filePath: item.filePath
          })
          interpretOrThrowRefusalMessage(() => mutation.interpret(response), failureMessage)
        }
        triggerSuccess()
        await loadReviewData()
        return true
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
        return false
      } finally {
        setBusyAction(null)
      }
    },
    [client, connState, loadReviewData, setActionError, setBusyAction, worktreeId]
  )

  return { runGitMutation }
}
