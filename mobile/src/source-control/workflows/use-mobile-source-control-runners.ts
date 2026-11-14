import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { translate } from '../../i18n/mobile-i18n'
import type { RouteHandoff } from '../../navigation/route-handoff'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { triggerError, triggerSuccess } from '../../platform/haptics/haptics'
import { useMobileCommitMessageGeneration } from '../commits/use-mobile-commit-message-generation'
import { useMobileSourceControlCommitRunners } from '../commits/use-mobile-source-control-commit-runners'
import { useMobileSourceControlActionSheetRunners } from './use-mobile-source-control-action-sheet-runners'
import { useMobileStageAllRunner } from './use-mobile-stage-all-runner'
import { useMobileConflictRunners } from '../conflicts/use-mobile-conflict-runners'
import type { RuntimeGitLocalBranches } from '../../../../src/shared/runtime-worktree-contracts'
import type { MobileGitStatusHostPayload as MobileGitStatusResult } from '../git/git-status-reply-schema'
import type { LoadStatusOptions } from '../changes/mobile-source-control-screen-state'
import type {
  MobileCommitFailureRecovery,
  RecordMobileCommitFailure
} from '../commits/mobile-commit-failure-recovery'

type GitStep = { method: string; params?: Record<string, unknown> }
type SendGitRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

type Params = {
  client: RpcClient | null
  hostId: string
  worktreeId: string
  status: MobileGitStatusResult | null
  commitMessage: string
  stagedEntries: MobileCommitFailureRecovery['stagedEntries']
  generatingMessage: boolean
  stageablePaths: string[]
  unstageablePaths: string[]
  router: RouteHandoff
  sendGitRequest: SendGitRequest
  sendCommitRequest: (message: string) => Promise<unknown>
  runGitSyncSteps: () => Promise<void>
  loadStatus: (options?: LoadStatusOptions) => Promise<boolean>
  mountedRef: MutableRefObject<boolean>
  busyActionRef: MutableRefObject<string | null>
  setBusyAction: (next: string | null) => void
  setActionError: (next: string | null) => void
  setCommitMessage: Dispatch<SetStateAction<string>>
  setGeneratingMessage: (next: boolean) => void
  setShowActionSheet: (next: boolean) => void
  setLocalBranches: (next: RuntimeGitLocalBranches | null) => void
  setShowBranchPicker: (next: boolean) => void
  recordCommitFailure: RecordMobileCommitFailure
  onOpenHistory?: () => void
  /** Every Create PR entry opens the one Create PR sheet. */
  onCreatePr?: () => void
}

export function useMobileSourceControlRunners(params: Params) {
  const {
    client,
    hostId,
    worktreeId,
    status,
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
    recordCommitFailure,
    onOpenHistory,
    onCreatePr
  } = params

  const runGitWorkflow = useCallback(
    async (
      actionId: string,
      runner: () => Promise<void>,
      options?: { clearCommitMessage?: string; refreshOnError?: boolean }
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
        // The commit landed, so its message must not come back, even when the screen has left.
        const committed = options?.clearCommitMessage
        if (committed !== undefined) {
          setCommitMessage((current) => (current.trim() === committed ? '' : current))
        }
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
        const text = translate('sourceControl.runners.actionFailed', 'Source control action failed')
        setActionError(err instanceof Error ? err.message : text)
        if (options?.refreshOnError) {
          // Keep the reason visible: a successful reload clears the action error by default.
          await loadStatus({
            force: true,
            clearActionErrorOnSuccess: false
          })
        }
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
    async (actionId: string, steps: GitStep[], options?: { clearCommitMessage?: string }) => {
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

  const stageAll = useMobileStageAllRunner({
    status,
    stageablePaths,
    runGitWorkflow,
    sendGitRequest
  })

  const unstageAll = useCallback(async () => {
    if (unstageablePaths.length === 0) {
      return
    }
    await runGitAction('unstage-all', 'git.bulkUnstage', { filePaths: unstageablePaths })
  }, [runGitAction, unstageablePaths])

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

  const { commit, runCommitSequence, runCommitSyncSequence } = useMobileSourceControlCommitRunners({
    commitMessage,
    stagedEntries,
    sendGitRequest,
    sendCommitRequest,
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
  })

  // pushFirst is kept for the action sheet's two rows; the sheet pushes first whenever it has to.
  const createPr = useCallback(
    (_pushFirst: boolean) => {
      setShowActionSheet(false)
      if (!status?.branch) {
        triggerError()
        setActionError(
          translate(
            'sourceControl.useMobileCreatePrRunner.branchRequired',
            'Check out a branch before creating a pull request.'
          )
        )
        return
      }
      onCreatePr?.()
    },
    [onCreatePr, setActionError, setShowActionSheet, status?.branch]
  )

  const openBranchPicker = useCallback(() => {
    setShowActionSheet(false)
    setLocalBranches(null)
    setShowBranchPicker(true)
    if (client) {
      void sendGitRequest<RuntimeGitLocalBranches>('git.localBranches')
        .then((result) => {
          if (mountedRef.current) {
            setLocalBranches(result)
          }
        })
        .catch(() => {
          if (mountedRef.current) {
            setLocalBranches({ current: null, branches: [] })
          }
        })
    }
  }, [
    client,
    mountedRef,
    sendGitRequest,
    setLocalBranches,
    setShowActionSheet,
    setShowBranchPicker
  ])

  const openHistory = useCallback(() => {
    setShowActionSheet(false)
    // History is a local hub segment; fallback navigation targets the hub directly to avoid a redirect hop.
    if (onOpenHistory) {
      onOpenHistory()
      return
    }
    if (hostId && worktreeId) {
      router.push({
        pathname: '/h/[hostId]/source-control/[worktreeId]',
        params: {
          hostId,
          worktreeId,
          tab: 'history'
        }
      } as Parameters<typeof router.push>[0])
    }
  }, [hostId, onOpenHistory, router, setShowActionSheet, worktreeId])

  const checkoutBranch = useCallback(
    async (branch: string) => {
      setShowBranchPicker(false)
      // A host can report a switch that landed with files left behind; show the branch it is on.
      await runGitWorkflow(
        'checkout',
        async () => {
          await sendGitRequest<unknown>('git.checkout', { branch })
        },
        { refreshOnError: true }
      )
    },
    [runGitWorkflow, sendGitRequest, setShowBranchPicker]
  )

  const actionSheetRunners = useMobileSourceControlActionSheetRunners({
    client,
    sendGitRequest,
    runGitWorkflow,
    runGitSequence,
    runGitSync,
    commit,
    runCommitSequence,
    runCommitSyncSequence,
    setShowActionSheet
  })

  const conflictRunners = useMobileConflictRunners({ sendGitRequest, runGitAction, runGitWorkflow })

  return {
    runGitAction,
    stageAll,
    unstageAll,
    commit,
    generateCommitMessage,
    cancelGenerateCommitMessage,
    createPr,
    openBranchPicker,
    openHistory,
    checkoutBranch,
    ...conflictRunners,
    ...actionSheetRunners
  }
}
