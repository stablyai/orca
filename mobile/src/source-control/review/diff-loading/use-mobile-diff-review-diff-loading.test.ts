import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../../../mobile-web-shell/bridge-host-test-fakes'
import {
  documentQueryClient,
  settleQueryNotifications
} from '../../../test-support/rpc-recording/hook-mount'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import type { MobileDiffReviewQueueItem } from '../diff-state/mobile-diff-review-queue'
import type {
  ReviewDiffState,
  ReviewScreenState
} from '../diff-state/mobile-diff-review-screen-model'
import { useMobileDiffReviewDiffLoading } from './use-mobile-diff-review-diff-loading'

const READY: ReviewScreenState = {
  kind: 'ready',
  status: { entries: [] },
  branchCompare: null,
  comments: [],
  reviewState: { version: 1, files: {} }
}

function unstaged(filePath: string): MobileDiffReviewQueueItem {
  return {
    key: `unstaged:${filePath}`,
    scope: 'unstaged',
    area: 'unstaged',
    filePath,
    status: 'modified',
    title: filePath,
    subtitle: '',
    canStage: true,
    canUnstage: false,
    canDiscard: true,
    isGeneratedOrLockFile: false,
    diffIdentity: filePath,
    noteCount: 0,
    unsentNoteCount: 0,
    staleNoteCount: 0,
    isReviewed: false,
    changedSinceReview: false
  }
}

const BRANCH: ReviewScreenState = {
  ...READY,
  branchCompare: {
    summary: {
      baseRef: 'origin/main',
      changedFiles: 1,
      status: 'ready',
      headOid: 'head-1',
      mergeBase: 'base-1'
    },
    entries: []
  }
}

function branchDeleted(filePath: string): MobileDiffReviewQueueItem {
  return {
    ...unstaged(filePath),
    key: `branch:${filePath}`,
    scope: 'branch',
    area: 'branch',
    status: 'deleted'
  }
}

const REFUSED: RpcResponse = {
  id: 'diff',
  ok: false,
  error: { code: 'internal_error', message: 'git is busy' },
  _meta: { runtimeId: 'runtime-1' }
}

const client = createFakeRpcClient()
const queries = documentQueryClient()
let tree: ReactTestRenderer | null = null
let diff: ReviewDiffState = { kind: 'idle' }

function Probe({
  item,
  queue,
  statusRevision,
  screenState
}: {
  item: MobileDiffReviewQueueItem
  queue: readonly MobileDiffReviewQueueItem[]
  statusRevision: number
  screenState: ReviewScreenState
}) {
  diff = useMobileDiffReviewDiffLoading({
    hostId: 'host',
    client,
    connState: 'connected',
    target: { exec: 'local', worktree: 'wt' },
    currentItem: item,
    filteredQueue: queue,
    currentIndex: queue.indexOf(item),
    screenState,
    statusRevision
  })
  return null
}

async function show(
  item: MobileDiffReviewQueueItem,
  statusRevision = 1,
  queue: readonly MobileDiffReviewQueueItem[] = [item],
  screenState: ReviewScreenState = READY
): Promise<void> {
  const element = queries.wrap(createElement(Probe, { item, queue, statusRevision, screenState }))
  await act(async () => {
    if (tree) {
      tree.update(element)
    } else {
      tree = create(element)
    }
  })
}

async function answerDiff(filePath: string, modified: string): Promise<void> {
  await answer(
    'git.diff',
    filePath,
    rpcSuccess('diff', { kind: 'text', originalContent: 'a\n', modifiedContent: modified })
  )
}

async function answer(method: string, filePath: string, reply: RpcResponse): Promise<void> {
  const request = client.requests.findLast((sent) => {
    const params = sent.args[1]
    return (
      sent.method === method &&
      typeof params === 'object' &&
      params !== null &&
      'filePath' in params &&
      params.filePath === filePath
    )
  })
  await act(async () => request?.resolve(reply))
  await settleQueryNotifications()
}

afterEach(async () => {
  await act(async () => tree?.unmount())
  tree = null
  client.requests.length = 0
  await queries.end()
})

it('shows the failure, not the older lines, when a newer status read of the open file fails', async () => {
  await show(unstaged('a.ts'), 1)
  await answerDiff('a.ts', 'a\nolder\n')
  await show(unstaged('a.ts'), 2)
  expect(JSON.stringify(diff)).toContain('older')
  await answer('git.diff', 'a.ts', REFUSED)
  expect(diff).toMatchObject({ kind: 'error', itemKey: 'unstaged:a.ts', message: 'git is busy' })
})

it('reads a committed deleted file again when its last read was refused', async () => {
  const deleted = branchDeleted('gone.ts')
  await show(deleted, 1, [deleted], BRANCH)
  await answer('git.branchDiff', 'gone.ts', REFUSED)
  expect(diff).toMatchObject({ kind: 'deleted', itemKey: 'branch:gone.ts' })
  await show(unstaged('a.ts'))
  await show(deleted, 1, [deleted], BRANCH)
  await answer(
    'git.branchDiff',
    'gone.ts',
    rpcSuccess('diff', { kind: 'text', originalContent: 'gone\n', modifiedContent: '' })
  )
  expect(diff).toMatchObject({ kind: 'ready', itemKey: 'branch:gone.ts' })
})
