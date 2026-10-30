import { useCallback } from 'react'
import type { ConflictResolution } from '../../../src/shared/source-control-entry-actions'
import { isMobileGitUnavailable } from './mobile-git-status'
import { translate } from '../i18n/mobile-i18n'
import {
  MOBILE_COMPLETE_MERGE_ACTION_ID,
  mobileConflictNeedsNewerHostMessage
} from './mobile-source-control-conflict-actions'
import type { MobileGitStatusEntryView } from './mobile-source-control-screen-state'

type SendGitRequest = (method: string, params?: Record<string, unknown>) => Promise<unknown>

type Params = {
  sendGitRequest: SendGitRequest
  runGitAction: (actionId: string, method: string, p: Record<string, unknown>) => Promise<boolean>
  runGitWorkflow: (actionId: string, runner: () => Promise<void>) => Promise<boolean>
}

/** Abort, resolve and complete a paused merge through the host ops desktop uses. */
export function useMobileConflictRunners({ sendGitRequest, runGitAction, runGitWorkflow }: Params) {
  // Hosts older than these ops refuse them; say what to do instead of echoing the raw refusal.
  const sendConflictRequest = useCallback(
    async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      try {
        return await sendGitRequest(method, params)
      } catch (err) {
        const code =
          err instanceof Error && 'code' in err && typeof err.code === 'string'
            ? err.code
            : undefined
        if (isMobileGitUnavailable(code, err instanceof Error ? err.message : undefined)) {
          throw new Error(mobileConflictNeedsNewerHostMessage())
        }
        throw err
      }
    },
    [sendGitRequest]
  )

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

  const resolveConflict = useCallback(
    async (
      entry: Pick<MobileGitStatusEntryView, 'path' | 'resolveActionId'>,
      resolution: ConflictResolution
    ) => {
      await runGitWorkflow(entry.resolveActionId, async () => {
        await sendConflictRequest('git.resolveConflict', {
          filePath: entry.path,
          resolution
        })
      })
    },
    [runGitWorkflow, sendConflictRequest]
  )

  const completeMerge = useCallback(async () => {
    await runGitWorkflow(MOBILE_COMPLETE_MERGE_ACTION_ID, async () => {
      // completeMerge reports Git's refusal in-band, like git.commit.
      const failure = readCompleteMergeFailure(await sendConflictRequest('git.completeMerge'))
      if (failure) {
        throw new Error(failure)
      }
    })
  }, [runGitWorkflow, sendConflictRequest])

  return { abortConflictOperation, resolveConflict, completeMerge }
}

function readCompleteMergeFailure(result: unknown): string | null {
  const fallback = translate(
    'sourceControl.conflictActions.completeMergeFailed',
    'Complete merge failed'
  )
  if (typeof result !== 'object' || result === null) {
    return fallback
  }
  if ('success' in result && result.success === true) {
    return null
  }
  return 'error' in result && typeof result.error === 'string' && result.error
    ? result.error
    : fallback
}
