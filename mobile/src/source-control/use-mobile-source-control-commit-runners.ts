import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { translate } from '../i18n/mobile-i18n'
import { triggerError, triggerSuccess } from '../platform/haptics/haptics'
import type { LoadStatusOptions } from './mobile-source-control-screen-state'
import type {
  MobileCommitFailureRecovery,
  RecordMobileCommitFailure
} from './mobile-commit-failure-recovery'

type GitStep = { method: string; params?: Record<string, unknown> }
type SendGitRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>
type RunGitWorkflow = (
  actionId: string,
  runner: () => Promise<void>,
  // The committed message; the field is cleared only while it still holds that text.
  options?: { clearCommitMessage?: string }
) => Promise<boolean>

type Params = {
  commitMessage: string
  stagedEntries: MobileCommitFailureRecovery['stagedEntries']
  sendGitRequest: SendGitRequest
  sendCommitRequest: (message: string) => Promise<unknown>
  cancelGenerateCommitMessage: () => void
  runGitSyncSteps: () => Promise<void>
  runGitWorkflow: RunGitWorkflow
  loadStatus: (options?: LoadStatusOptions) => Promise<boolean>
  mountedRef: MutableRefObject<boolean>
  busyActionRef: MutableRefObject<string | null>
  setBusyAction: (next: string | null) => void
  setActionError: (next: string | null) => void
  setCommitMessage: Dispatch<SetStateAction<string>>
  recordCommitFailure: RecordMobileCommitFailure
}

export function useMobileSourceControlCommitRunners(params: Params) {
  const {
    commitMessage,
    stagedEntries,
    sendGitRequest,
    sendCommitRequest: sendCommitRequestOnly,
    cancelGenerateCommitMessage,
    runGitSyncSteps,
    runGitWorkflow,
    loadStatus,
    mountedRef,
    busyActionRef,
    setBusyAction,
    setActionError,
    setCommitMessage,
    recordCommitFailure
  } = params
  // Cancel generation before committing so its late reply cannot refill the cleared message box.
  const sendCommitRequest = useCallback(
    (message: string) => {
      cancelGenerateCommitMessage()
      return sendCommitRequestOnly(message)
    },
    [cancelGenerateCommitMessage, sendCommitRequestOnly]
  )

  const commit = useCallback(async () => {
    const message = commitMessage.trim()
    if (!message) {
      return false
    }
    return await runGitWorkflow(
      'commit',
      async () => {
        try {
          await sendCommitRequest(message)
        } catch (err) {
          recordCommitFailure({
            error:
              err instanceof Error
                ? err.message
                : translate('sourceControl.commitRunners.commitFailed', 'Commit failed'),
            commitMessage: message,
            stagedEntries
          })
          throw err
        }
      },
      { clearCommitMessage: message }
    )
  }, [commitMessage, recordCommitFailure, runGitWorkflow, sendCommitRequest, stagedEntries])

  const runCommitFollowUps = useCallback(
    async (actionId: string, afterCommit: () => Promise<void>) => {
      const message = commitMessage.trim()
      if (!message) {
        return false
      }
      if (busyActionRef.current) {
        return false
      }
      busyActionRef.current = actionId
      setBusyAction(actionId)
      setActionError(null)
      recordCommitFailure(null)
      let didCommit = false
      try {
        await sendCommitRequest(message)
        didCommit = true
        // The commit landed: a kill during the push must not bring its message back, and text typed since stays.
        setCommitMessage((current) => (current.trim() === message ? '' : current))
        await afterCommit()
        if (!mountedRef.current) {
          return false
        }
        triggerSuccess()
        await loadStatus({ force: true })
        return true
      } catch (err) {
        if (!mountedRef.current) {
          return false
        }
        triggerError()
        const errorMessage =
          err instanceof Error
            ? err.message
            : translate('sourceControl.commitRunners.actionFailed', 'Source control action failed')
        if (!didCommit) {
          recordCommitFailure({ error: errorMessage, commitMessage: message, stagedEntries })
        }
        if (didCommit) {
          await loadStatus({
            clearActionErrorOnSuccess: false,
            force: true
          })
        }
        setActionError(errorMessage)
        return false
      } finally {
        if (busyActionRef.current === actionId) {
          busyActionRef.current = null
          if (mountedRef.current) {
            setBusyAction(null)
          }
        }
      }
    },
    [
      busyActionRef,
      commitMessage,
      loadStatus,
      mountedRef,
      recordCommitFailure,
      sendCommitRequest,
      setActionError,
      setBusyAction,
      setCommitMessage,
      stagedEntries
    ]
  )

  const runCommitSequence = useCallback(
    async (actionId: string, afterCommit: GitStep[]) => {
      return await runCommitFollowUps(actionId, async () => {
        for (const step of afterCommit) {
          await sendGitRequest<unknown>(step.method, step.params)
        }
      })
    },
    [runCommitFollowUps, sendGitRequest]
  )

  const runCommitSyncSequence = useCallback(async () => {
    return await runCommitFollowUps('commit-sync', runGitSyncSteps)
  }, [runCommitFollowUps, runGitSyncSteps])

  return { commit, runCommitSequence, runCommitSyncSequence }
}
