import { useCallback, type MutableRefObject } from 'react'
import { useRouter } from 'expo-router'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileCommitMessageGeneration } from './use-mobile-commit-message-generation'
import { useMobileSourceControlCommitRunners } from './use-mobile-source-control-commit-runners'
import { useMobileSourceControlActionSheetRunners } from './use-mobile-source-control-action-sheet-runners'
import { useMobileSourceControlBranchRunners } from './use-mobile-source-control-branch-runners'
import { useMobileCreatePrRunner } from './use-mobile-create-pr-runner'
import type { RuntimeGitLocalBranches } from '../../../src/shared/runtime-types'
import type { MobileGitStatusResult } from './mobile-git-status'
import type { LoadStatusOptions } from './mobile-source-control-screen-state'
import type {
  MobileCommitFailureRecovery,
  RecordMobileCommitFailure
} from './mobile-commit-failure-recovery'
import type { HostSourceControlFeedback } from './host-source-control-binding'

type GitStep = { method: string; params?: Record<string, unknown> }
type SendGitRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

type Params = {
  client: RpcClient | null
  hostId: string
  worktreeId: string
  status: MobileGitStatusResult | null
  branchLabel: string
  commitMessage: string
  stagedEntries: MobileCommitFailureRecovery['stagedEntries']
  generatingMessage: boolean
  stageablePaths: string[]
  unstageablePaths: string[]
  router: ReturnType<typeof useRouter>
  sendGitRequest: SendGitRequest
  sendCommitRequest: (message: string) => Promise<unknown>
  runGitSyncSteps: () => Promise<void>
  loadStatus: (options?: LoadStatusOptions) => Promise<boolean>
  mountedRef: MutableRefObject<boolean>
  busyActionRef: MutableRefObject<string | null>
  setBusyAction: (next: string | null) => void
  setActionError: (next: string | null) => void
  setCommitMessage: (next: string) => void
  setGeneratingMessage: (next: boolean) => void
  setShowActionSheet: (next: boolean) => void
  setLocalBranches: (next: RuntimeGitLocalBranches | null) => void
  setShowBranchPicker: (next: boolean) => void
  setCreatedPrUrl: (next: string | null) => void
  setCreatedPrWarning: (next: string | null) => void
  recordCommitFailure: RecordMobileCommitFailure
  onOpenHistory?: () => void
  feedback: HostSourceControlFeedback
}

export function useMobileSourceControlRunners(params: Params) {
  const {
    client,
    hostId,
    worktreeId,
    status,
    branchLabel,
    commitMessage,
    stagedEntries,
    generatingMessage,
    stageablePaths,
    unstageablePaths,
    router,
    sendGitRequest,
    sendCommitRequest,
    runGitSyncSteps,
    loadStatus,
    mountedRef,
    busyActionRef,
    setBusyAction,
    setActionError,
    setCommitMessage,
    setGeneratingMessage,
    setShowActionSheet,
    setLocalBranches,
    setShowBranchPicker,
    setCreatedPrUrl,
    setCreatedPrWarning,
    recordCommitFailure,
    onOpenHistory,
    feedback
  } = params

  const runGitWorkflow = useCallback(
    async (
      actionId: string,
      runner: () => Promise<void>,
      options?: { clearCommitMessage?: boolean }
    ) => {
      if (busyActionRef.current) {
        return false
      }
      busyActionRef.current = actionId
      setBusyAction(actionId)
      setActionError(null)
      recordCommitFailure(null)
      try {
        await runner()
        if (!mountedRef.current) {
          return false
        }
        if (options?.clearCommitMessage) {
          setCommitMessage('')
        }
        feedback.success()
        await loadStatus({ preserveReadyOnFailure: true, force: true })
        return true
      } catch (err) {
        if (!mountedRef.current) {
          return false
        }
        feedback.error()
        setActionError(err instanceof Error ? err.message : 'Source control action failed')
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
      feedback,
      loadStatus,
      mountedRef,
      recordCommitFailure,
      setActionError,
      setBusyAction,
      setCommitMessage
    ]
  )

  const runGitAction = useCallback(
    async (actionId: string, method: string, p: Record<string, unknown>) => {
      return await runGitWorkflow(actionId, async () => {
        await sendGitRequest<unknown>(method, p)
      })
    },
    [runGitWorkflow, sendGitRequest]
  )

  const runGitSequence = useCallback(
    async (actionId: string, steps: GitStep[], options?: { clearCommitMessage?: boolean }) => {
      return await runGitWorkflow(
        actionId,
        async () => {
          for (const step of steps) {
            await sendGitRequest<unknown>(step.method, step.params)
          }
        },
        options
      )
    },
    [runGitWorkflow, sendGitRequest]
  )

  const runGitSync = useCallback(
    async (actionId: string) => await runGitWorkflow(actionId, runGitSyncSteps),
    [runGitSyncSteps, runGitWorkflow]
  )

  const stageAll = useCallback(async () => {
    if (stageablePaths.length === 0) {
      return
    }
    await runGitAction('stage-all', 'git.bulkStage', {
      filePaths: stageablePaths
    })
  }, [runGitAction, stageablePaths])

  const unstageAll = useCallback(async () => {
    if (unstageablePaths.length === 0) {
      return
    }
    await runGitAction('unstage-all', 'git.bulkUnstage', {
      filePaths: unstageablePaths
    })
  }, [runGitAction, unstageablePaths])

  const { commit, runCommitSequence, runCommitSyncSequence } = useMobileSourceControlCommitRunners({
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
  })

  const { generateCommitMessage, cancelGenerateCommitMessage } = useMobileCommitMessageGeneration({
    client,
    worktreeId,
    generatingMessage,
    mountedRef,
    busyActionRef,
    setGeneratingMessage,
    setCommitMessage,
    setActionError
  })

  const createPr = useMobileCreatePrRunner({
    client,
    worktreeId,
    status,
    branchLabel,
    commitMessage,
    stagedEntries,
    mountedRef,
    runGitWorkflow,
    loadStatus,
    setActionError,
    setCommitMessage,
    setShowActionSheet,
    setCreatedPrUrl,
    setCreatedPrWarning,
    recordCommitFailure
  })

  const branchRunners = useMobileSourceControlBranchRunners({
    client,
    hostId,
    worktreeId,
    router,
    sendGitRequest,
    runGitAction,
    mountedRef,
    setShowActionSheet,
    setLocalBranches,
    setShowBranchPicker,
    onOpenHistory
  })

  const actionSheetRunners = useMobileSourceControlActionSheetRunners({
    client,
    worktreeId,
    sendGitRequest,
    runGitWorkflow,
    runGitSequence,
    runGitSync,
    commit,
    runCommitSequence,
    runCommitSyncSequence,
    setShowActionSheet
  })

  // Abort an in-progress merge/rebase from the conflict banner.
  const abortConflictOperation = useCallback(
    async (operation: string) => {
      const method =
        operation === 'merge' ? 'git.abortMerge' : operation === 'rebase' ? 'git.abortRebase' : null
      if (!method) {
        return
      }
      await runGitAction(`abort-${operation}`, method, {})
    },
    [runGitAction]
  )

  return {
    runGitAction,
    stageAll,
    unstageAll,
    commit,
    generateCommitMessage,
    cancelGenerateCommitMessage,
    createPr,
    abortConflictOperation,
    ...branchRunners,
    ...actionSheetRunners
  }
}
