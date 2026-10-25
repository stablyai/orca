import { useCallback } from 'react'
import { requireGitStageWorktreeScopeReceipt } from '../../../src/shared/git-stage-worktree-scope'
import type { MobileGitStatusResult } from './mobile-git-status'

type Params = {
  status: MobileGitStatusResult | null
  stageablePaths: string[]
  runGitWorkflow: (actionId: string, runner: () => Promise<void>) => Promise<boolean>
  sendGitRequest: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

export function useMobileStageAllRunner({
  status,
  stageablePaths,
  runGitWorkflow,
  sendGitRequest
}: Params): () => Promise<void> {
  // The loose schema carries this only when the host publishes it; older hosts omit it.
  const isStatusCapped = status?.didHitLimit === true
  return useCallback(async () => {
    if (isStatusCapped) {
      // Send no paths: older hosts strip scope and must fail the receipt check rather than silently stage a partial list.
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
