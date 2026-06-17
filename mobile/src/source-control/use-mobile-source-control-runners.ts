import { useCallback, type MutableRefObject } from 'react'
import { useRouter } from 'expo-router'
import type { RpcClient } from '../transport/rpc-client'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { MobilePrPrefill } from './mobile-pr-create'
import { buildOpenPrPrefill, readFreshGitStatus } from './mobile-open-pr-prefill'
import { useMobileCommitMessageGeneration } from './use-mobile-commit-message-generation'
import { useMobileSourceControlCommitRunners } from './use-mobile-source-control-commit-runners'
import { useMobileSourceControlActionSheetRunners } from './use-mobile-source-control-action-sheet-runners'
import type { RuntimeGitLocalBranches } from '../../../src/shared/runtime-types'
import type { MobileGitStatusResult } from './mobile-git-status'
import type { LoadStatusOptions } from './mobile-source-control-screen-state'

type GitStep = { method: string; params?: Record<string, unknown> }
type SendGitRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

type Params = {
  client: RpcClient | null
  hostId: string
  worktreeId: string
  status: MobileGitStatusResult | null
  branchLabel: string
  commitMessage: string
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
  setPrPrefill: (next: MobilePrPrefill | null) => void
  setShowPrSheet: (next: boolean) => void
}

// All git workflow + action-sheet runners for the source-control panel. Split
// out of the state hook to keep each file under the line limit; behavior is
// unchanged from the original inline definitions.
export function useMobileSourceControlRunners(params: Params) {
  const {
    client,
    hostId,
    worktreeId,
    status,
    branchLabel,
    commitMessage,
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
    setPrPrefill,
    setShowPrSheet
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
      try {
        await runner()
        if (!mountedRef.current) {
          return false
        }
        if (options?.clearCommitMessage) {
          setCommitMessage('')
        }
        triggerSuccess()
        await loadStatus({ preserveReadyOnFailure: true, force: true })
        return true
      } catch (err) {
        if (!mountedRef.current) {
          return false
        }
        triggerError()
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
    [busyActionRef, loadStatus, mountedRef, setActionError, setBusyAction, setCommitMessage]
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
    await runGitAction('stage-all', 'git.bulkStage', { filePaths: stageablePaths })
  }, [runGitAction, stageablePaths])

  const unstageAll = useCallback(async () => {
    if (unstageablePaths.length === 0) {
      return
    }
    await runGitAction('unstage-all', 'git.bulkUnstage', { filePaths: unstageablePaths })
  }, [runGitAction, unstageablePaths])

  const { commit, runCommitSequence, runCommitSyncSequence } = useMobileSourceControlCommitRunners({
    commitMessage,
    sendGitRequest,
    sendCommitRequest,
    runGitSyncSteps,
    runGitWorkflow,
    loadStatus,
    mountedRef,
    busyActionRef,
    setBusyAction,
    setActionError,
    setCommitMessage
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

  const openPrSheet = useCallback(
    async (pushFirst: boolean) => {
      setShowActionSheet(false)
      let effectiveStatus = status
      if (pushFirst) {
        const pushed = await runGitWorkflow('push-create-pr', async () => {
          await sendGitRequest<unknown>('git.push')
        })
        if (!pushed || !mountedRef.current) {
          return
        }
        // Why: the captured `status` predates the push, so its upstream/ahead data is
        // stale; read fresh git.status so the prefill reflects the just-pushed branch.
        if (client) {
          effectiveStatus = await readFreshGitStatus(worktreeId, status, sendGitRequest)
          if (!mountedRef.current) {
            return
          }
        }
      }
      const prefill = await buildOpenPrPrefill(client, worktreeId, effectiveStatus, branchLabel)
      if (!mountedRef.current) {
        return
      }
      setPrPrefill(prefill)
      setShowPrSheet(true)
    },
    [
      branchLabel,
      client,
      mountedRef,
      runGitWorkflow,
      sendGitRequest,
      setPrPrefill,
      setShowActionSheet,
      setShowPrSheet,
      status,
      worktreeId
    ]
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
    if (hostId && worktreeId) {
      router.push(
        `/h/${hostId}/history/${encodeURIComponent(worktreeId)}` as Parameters<
          typeof router.push
        >[0]
      )
    }
  }, [hostId, router, setShowActionSheet, worktreeId])

  // Switch to a local branch, then reload status.
  const checkoutBranch = useCallback(
    async (branch: string) => {
      setShowBranchPicker(false)
      await runGitAction('checkout', 'git.checkout', { branch })
    },
    [runGitAction, setShowBranchPicker]
  )

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
    openPrSheet,
    openBranchPicker,
    openHistory,
    checkoutBranch,
    abortConflictOperation,
    ...actionSheetRunners
  }
}
