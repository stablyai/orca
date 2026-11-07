import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import { loadMobileDiffReviewDiff, mobileReviewDiffInput } from './mobile-diff-review-loaders'

const DELETED_ITEM: MobileDiffReviewQueueItem = {
  key: 'unstaged\0unstaged\0\0deleted.ts',
  scope: 'unstaged',
  area: 'unstaged',
  filePath: 'deleted.ts',
  status: 'deleted',
  title: 'deleted.ts',
  subtitle: 'Unstaged',
  canStage: true,
  canUnstage: false,
  canDiscard: true,
  isGeneratedOrLockFile: false,
  diffIdentity: 'deleted-diff',
  noteCount: 0,
  unsentNoteCount: 0,
  staleNoteCount: 0,
  isReviewed: false,
  changedSinceReview: false
}

function clientWith(response: RpcResponse): RpcClient {
  return {
    sendRequest: vi.fn().mockResolvedValue(response)
  } as unknown as RpcClient
}

function failure(code: string, message: string): RpcResponse {
  return { id: 'rpc-1', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime-1' } }
}

function deletedInput() {
  return mobileReviewDiffInput(DELETED_ITEM, {
    branchCompare: null,
    commit: null,
    statusRevision: 1,
    ignoreTrimWhitespace: false
  })
}

describe('loadMobileDiffReviewDiff', () => {
  it('shows the too-large state for an oversized deleted diff', async () => {
    await expect(
      loadMobileDiffReviewDiff(
        clientWith(failure('diff_too_large', 'Diff too large')),
        'wt-1',
        deletedInput()
      )
    ).resolves.toEqual({ kind: 'too-large', itemKey: DELETED_ITEM.key })
  })

  it('keeps the deleted fallback for hosts that cannot return deleted content', async () => {
    await expect(
      loadMobileDiffReviewDiff(
        clientWith(failure('internal_error', 'Unable to read deleted file')),
        'wt-1',
        deletedInput()
      )
    ).resolves.toEqual({ kind: 'deleted', itemKey: DELETED_ITEM.key })
  })
})
