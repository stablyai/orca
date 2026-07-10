import { useCallback, type MutableRefObject } from 'react'
import { triggerError, triggerSuccess } from '../platform/haptics'
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
  options?: { clearCommitMessage?: boolean }
) => Promise<boolean>

type Params = {
  commitMessage: string
  stagedEntries: MobileCommitFailureRecovery['stagedEntries']
  sendGitRequest: SendGitRequest
  sendCommitRequest: (message: string) => Promise<unknown>
  runGitSyncSteps: () => Promise<void>
  runGitWorkflow: RunGitWorkflow
  loadStatus: (options?: LoadStatusOptions) => Promise<boolean>
  mountedRef: MutableRefObject<boolean>
  busyActionRef: MutableRefObject<string | null>
  setBusyAction: (next: string | null) => void
  setActionError: (next: string | null) => void
  setCommitMessage: (next: string) => void
  recordCommitFailure: RecordMobileCommitFailure
}

// Commit + commit-then-action runners. Split from the main runners hook to keep
// each file under the line limit; behavior is unchanged from the original.
export function useMobileSourceControlCommitRunners(params: Params) {
  const {
    commitMessage,
    stagedEntries,
    sendGitRequest,
    sendCommitRequest,
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
            error: err instanceof Error ? err.message : 'Commit failed',
            commitMessage: message,
            stagedEntries
          })
          throw err
        }
      },
      { clearCommitMessage: true }
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
        await afterCommit()
        if (!mountedRef.current) {
          return false
        }
        setCommitMessage('')
        triggerSuccess()
        await loadStatus({ preserveReadyOnFailure: true, force: true })
        return true
      } catch (err) {
        if (!mountedRef.current) {
          return false
        }
        triggerError()
        const errorMessage = err instanceof Error ? err.message : 'Source control action failed'
        if (!didCommit) {
          recordCommitFailure({ error: errorMessage, commitMessage: message, stagedEntries })
        }
        if (didCommit) {
          setCommitMessage('')
          await loadStatus({
            preserveReadyOnFailure: true,
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
