import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import {
  loadMobileDiffReviewBranchCompare,
  loadMobileDiffReviewDiff
} from './mobile-diff-review-loaders'

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

describe('loadMobileDiffReviewDiff', () => {
  it('requests the base tip and preserves an older host comparison revision', async () => {
    const summary = {
      baseRef: 'main',
      baseOid: 'base-tip',
      compareRef: 'feature',
      headOid: 'head',
      mergeBase: 'legacy-ancestor',
      changedFiles: 0,
      status: 'ready'
    }
    const sendRequest = vi.fn(async (method: string): Promise<RpcResponse> => ({
      id: 'rpc-1',
      ok: true,
      result:
        method === 'worktree.show'
          ? { worktree: { baseRef: 'main' } }
          : method === 'repo.list'
            ? { repos: [] }
            : { summary, entries: [] },
      _meta: { runtimeId: 'runtime-1' }
    }))
    const client = { ...clientWith(failure('unused', 'unused')), sendRequest }

    const loaded = await loadMobileDiffReviewBranchCompare(client, 'repo::/wt')

    expect(sendRequest).toHaveBeenCalledWith('git.branchCompare', {
      worktree: 'id:repo::/wt',
      baseRef: 'main',
      compareBaseTip: true
    })
    expect(loaded.result?.summary.mergeBase).toBe('legacy-ancestor')
  })

  it('shows the too-large state for an oversized deleted diff', async () => {
    await expect(
      loadMobileDiffReviewDiff({
        client: clientWith(failure('diff_too_large', 'Diff too large')),
        worktreeId: 'wt-1',
        item: DELETED_ITEM,
        branchCompare: null
      })
    ).resolves.toEqual({ kind: 'too-large', itemKey: DELETED_ITEM.key })
  })

  it('keeps the deleted fallback for hosts that cannot return deleted content', async () => {
    await expect(
      loadMobileDiffReviewDiff({
        client: clientWith(failure('internal_error', 'Unable to read deleted file')),
        worktreeId: 'wt-1',
        item: DELETED_ITEM,
        branchCompare: null
      })
    ).resolves.toEqual({ kind: 'deleted', itemKey: DELETED_ITEM.key })
  })
})
