import { useCallback } from 'react'
import {
  runDiscardAllForArea,
  type DiscardAllArea,
  type DiscardAllResult
} from '../../../../src/shared/source-control/listing/source-control-discard-all-sequence'
import { translate } from '../../i18n/mobile-i18n'

type Params = {
  runGitWorkflow: (
    actionId: string,
    runner: () => Promise<void>,
    options?: { refreshOnError?: boolean }
  ) => Promise<boolean>
  sendGitRequest: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

/** Desktop's Discard all: one shared sequence, so a host that refuses git.bulkDiscard gets per-file discards. */
export function useMobileDiscardAllRunner({ runGitWorkflow, sendGitRequest }: Params) {
  return useCallback(
    async (area: DiscardAllArea, paths: readonly string[]) => {
      await runGitWorkflow(
        `discard-all-${area}`,
        async () => {
          const errors: unknown[] = []
          const result = await runDiscardAllForArea(area, paths, {
            bulkUnstage: async (filePaths) => {
              await sendGitRequest('git.bulkUnstage', { filePaths })
            },
            discardMany: async (filePaths) => {
              await sendGitRequest('git.bulkDiscard', { filePaths })
            },
            discardOne: async (filePath) => {
              await sendGitRequest('git.discard', { filePath })
            },
            onError: (error) => errors.push(error)
          })
          const failure = discardAllFailure(result, errors[0])
          if (failure) {
            throw new Error(failure)
          }
        },
        // Files that were discarded before a failure must leave the list.
        { refreshOnError: true }
      )
    },
    [runGitWorkflow, sendGitRequest]
  )
}

function discardAllFailure(result: DiscardAllResult, firstError: unknown): string | null {
  const detail = firstError instanceof Error ? firstError.message : ''
  if (result.aborted) {
    const lead = translate(
      'sourceControl.discardAll.unstageFailed',
      'Discard all failed — unable to unstage files before discard'
    )
    return detail ? `${lead}: ${detail}` : lead
  }
  if (result.failed.length === 0) {
    return null
  }
  const lead =
    result.failed.length === 1
      ? translate('sourceControl.discardAll.failed_one', 'Failed to discard {{count}} file', {
          count: 1
        })
      : translate('sourceControl.discardAll.failed_other', 'Failed to discard {{count}} files', {
          count: result.failed.length
        })
  return detail ? `${lead}: ${detail}` : lead
}
