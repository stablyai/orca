import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import {
  documentQueryClient,
  settleQueryNotifications
} from '../test-support/rpc-recording/hook-mount'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { ReviewDiffState, ReviewScreenState } from './mobile-diff-review-screen-model'
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

const client = createFakeRpcClient()
const queries = documentQueryClient()
let tree: ReactTestRenderer | null = null
let diff: ReviewDiffState = { kind: 'idle' }

function Probe({
  item,
  statusRevision
}: {
  item: MobileDiffReviewQueueItem
  statusRevision: number
}) {
  diff = useMobileDiffReviewDiffLoading({
    hostId: 'host',
    client,
    connState: 'connected',
    target: { exec: 'local', worktree: 'wt' },
    currentItem: item,
    screenState: READY,
    statusRevision
  })
  return null
}

async function show(item: MobileDiffReviewQueueItem, statusRevision = 1): Promise<void> {
  const element = queries.wrap(createElement(Probe, { item, statusRevision }))
  await act(async () => {
    if (tree) {
      tree.update(element)
    } else {
      tree = create(element)
    }
  })
}

async function answerDiff(filePath: string, modified: string): Promise<void> {
  const request = client.requests.findLast((sent) => {
    const params = sent.args[1]
    return (
      sent.method === 'git.diff' &&
      typeof params === 'object' &&
      params !== null &&
      'filePath' in params &&
      params.filePath === filePath
    )
  })
  await act(async () =>
    request?.resolve(
      rpcSuccess('diff', { kind: 'text', originalContent: 'a\n', modifiedContent: modified })
    )
  )
  await settleQueryNotifications()
}

afterEach(async () => {
  await act(async () => tree?.unmount())
  tree = null
  client.requests.length = 0
  await queries.end()
})

it('reopens a file already seen in this review without loading it again', async () => {
  await show(unstaged('a.ts'))
  await answerDiff('a.ts', 'a\nb\n')
  await show(unstaged('b.ts'))
  expect(diff).toMatchObject({ kind: 'loading', itemKey: 'unstaged:b.ts' })
  await show(unstaged('a.ts'))
  expect(diff).toMatchObject({ kind: 'ready', itemKey: 'unstaged:a.ts' })
})

it('reads a worktree diff again after a status change and shows the new lines', async () => {
  await show(unstaged('a.ts'), 1)
  await answerDiff('a.ts', 'a\nolder\n')
  await show(unstaged('a.ts'), 2)
  await answerDiff('a.ts', 'a\nnewer\n')
  expect(diff).toMatchObject({ kind: 'ready', itemKey: 'unstaged:a.ts' })
  expect(JSON.stringify(diff)).toContain('newer')
  expect(JSON.stringify(diff)).not.toContain('older')
})
