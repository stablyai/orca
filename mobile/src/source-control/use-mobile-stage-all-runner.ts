import { useCallback } from 'react'
import { requireGitStageWorktreeScopeReceipt } from '../../../src/shared/git-stage-worktree-scope'
import type { MobileGitStatusResult } from './mobile-git-status'

type Params = {
  status: MobileGitStatusResult | null
  stageablePaths: string[]
  runGitWorkflow: (actionId: string, runner: () => Promise<void>) => Promise<boolean>
  sendGitRequest: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

/** Stage All for the Changes screen, including rows a capped `git.status` did not list. */
export function useMobileStageAllRunner({
  status,
  stageablePaths,
  runGitWorkflow,
  sendGitRequest
}: Params): () => Promise<void> {
  // Why: undeclared in the reply schema, so it passes through loose and an older host omits it.
  const isStatusCapped = status?.didHitLimit === true
  return useCallback(async () => {
    if (isStatusCapped) {
      // Why no paths: an older host strips `scope` and stages `filePaths`, so it stages nothing
      // and the missing receipt reports that instead of a silently partial stage.
      await runGitWorkflow('stage-all', async () => {
        const reply = await sendGitRequest<unknown>('git.bulkStage', {
          filePaths: [],
          scope: 'all'
        })
        requireGitStageWorktreeScopeReceipt(reply, 'all')
      })
      return
    }
    if (stageablePaths.length === 0) {
      return
    }
    await runGitWorkflow('stage-all', async () => {
      await sendGitRequest<unknown>('git.bulkStage', { filePaths: stageablePaths })
    })
  }, [isStatusCapped, runGitWorkflow, sendGitRequest, stageablePaths])
}
