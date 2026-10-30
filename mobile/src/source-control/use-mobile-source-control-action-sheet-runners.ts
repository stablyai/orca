import { useCallback } from 'react'
import { translate } from '../i18n/mobile-i18n'
import type { RpcClient } from '../transport/rpc-client'

type GitStep = { method: string; params?: Record<string, unknown> }
type SendGitRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>
type RunGitWorkflow = (actionId: string, runner: () => Promise<void>) => Promise<boolean>

type Params = {
  client: RpcClient | null
  sendGitRequest: SendGitRequest
  runGitWorkflow: RunGitWorkflow
  runGitSequence: (actionId: string, steps: GitStep[]) => Promise<boolean>
  runGitSync: (actionId: string) => Promise<boolean>
  commit: () => Promise<boolean>
  runCommitSequence: (actionId: string, afterCommit: GitStep[]) => Promise<boolean>
  runCommitSyncSequence: () => Promise<boolean>
  setShowActionSheet: (next: boolean) => void
}

export function useMobileSourceControlActionSheetRunners(params: Params) {
  const {
    client,
    sendGitRequest,
    runGitWorkflow,
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

  // The row shows the base it rebases onto, so the press sends that same ref.
  const runActionSheetRebase = useCallback(
    async (baseRef: string | null) => {
      await runGitWorkflow('rebase', async () => {
        if (!client) {
          throw new Error(
            translate(
              'sourceControl.actionSheetRunners.waitingForDesktop',
              'Waiting for desktop...'
            )
          )
        }
        if (!baseRef) {
          throw new Error(
            translate(
              'sourceControl.actionSheetRunners.noBaseBranch',
              'No base branch to rebase onto'
            )
          )
        }
        await sendGitRequest<unknown>('git.rebaseFromBase', { baseRef })
      })
      setShowActionSheet(false)
    },
    [client, runGitWorkflow, sendGitRequest, setShowActionSheet]
  )

  return {
    runActionSheetCommit,
    runActionSheetCommitSequence,
    runActionSheetCommitSync,
    runActionSheetGitSequence,
    runActionSheetGitSync,
    runActionSheetRebase
  }
}
