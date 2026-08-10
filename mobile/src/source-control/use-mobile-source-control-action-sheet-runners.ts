import { useCallback } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { resolveMobileBranchCompareBaseRef } from './mobile-branch-base-ref'

type GitStep = { method: string; params?: Record<string, unknown> }
type SendGitRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>
type RunGitWorkflow = (actionId: string, runner: () => Promise<void>) => Promise<boolean>
type RunRemoteGitAction = <T>(run: (remainingMs: () => number) => Promise<T>) => Promise<T>

type Params = {
  client: RpcClient | null
  worktreeId: string
  sendGitRequest: SendGitRequest
  runGitWorkflow: RunGitWorkflow
  runRemoteGitAction: RunRemoteGitAction
  runGitSequence: (actionId: string, steps: GitStep[]) => Promise<boolean>
  runGitSync: (actionId: string) => Promise<boolean>
  commit: () => Promise<boolean>
  runCommitSequence: (actionId: string, afterCommit: GitStep[]) => Promise<boolean>
  runCommitSyncSequence: () => Promise<boolean>
  setShowActionSheet: (next: boolean) => void
}

// The action-sheet entry runners: each performs an action then dismisses the
// sheet. Split from the main runners hook to stay under the line limit.
export function useMobileSourceControlActionSheetRunners(params: Params) {
  const {
    client,
    worktreeId,
    sendGitRequest,
    runGitWorkflow,
    runRemoteGitAction,
    runGitSequence,
    runGitSync,
    commit,
    runCommitSequence,
    runCommitSyncSequence,
    setShowActionSheet
  } = params

  const runActionSheetCommit = useCallback(async () => {
    await commit()
    setShowActionSheet(false)
  }, [commit, setShowActionSheet])

  const runActionSheetCommitSequence = useCallback(
    async (actionId: string, afterCommit: GitStep[]) => {
      await runCommitSequence(actionId, afterCommit)
      setShowActionSheet(false)
    },
    [runCommitSequence, setShowActionSheet]
  )

  const runActionSheetCommitSync = useCallback(async () => {
    await runCommitSyncSequence()
    setShowActionSheet(false)
  }, [runCommitSyncSequence, setShowActionSheet])

  const runActionSheetGitSequence = useCallback(
    async (actionId: string, steps: GitStep[]) => {
      await runGitSequence(actionId, steps)
      setShowActionSheet(false)
    },
    [runGitSequence, setShowActionSheet]
  )

  const runActionSheetGitSync = useCallback(async () => {
    await runGitSync('sync')
    setShowActionSheet(false)
  }, [runGitSync, setShowActionSheet])

  const runActionSheetRebase = useCallback(async () => {
    await runGitWorkflow('rebase', () =>
      runRemoteGitAction(async (remainingMs) => {
        if (!client) {
          throw new Error('Waiting for desktop...')
        }
        const baseRef = await resolveMobileBranchCompareBaseRef(client, worktreeId, () => ({
          timeoutMs: remainingMs()
        }))
        if (!baseRef) {
          throw new Error('No base branch to rebase onto')
        }
        await sendGitRequest<unknown>('git.rebaseFromBase', { baseRef })
      })
    )
    setShowActionSheet(false)
  }, [client, runGitWorkflow, runRemoteGitAction, sendGitRequest, setShowActionSheet, worktreeId])

  return {
    runActionSheetCommit,
    runActionSheetCommitSequence,
    runActionSheetCommitSync,
    runActionSheetGitSequence,
    runActionSheetGitSync,
    runActionSheetRebase
  }
}
