import { createElement, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeSet } from '../../../src/shared/rpc-contract/worktree-params'
import { mergeWorktreeMetaForWrite } from '../../../src/main/persistence/loading-store/worktree-meta-write-normalization'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { WorktreeMeta } from '../../../src/shared/worktree/meta-types'
import type { RpcClient } from '../transport/rpc-client'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { useMobileSessionDiffComments } from './use-mobile-session-diff-comments'
import { useMobileDiffReviewCommentActions } from './use-mobile-diff-review-comment-actions'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'

vi.mock('../platform/haptics', () => ({
  triggerSuccess: vi.fn(),
  triggerError: vi.fn(),
  triggerSelection: vi.fn()
}))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText: vi.fn() }) }))

const note = (id: string): DiffComment => ({
  id,
  worktreeId: 'workspace',
  filePath: 'README.md',
  source: 'diff',
  lineNumber: 1,
  body: id,
  createdAt: 100,
  side: 'modified'
})
let renderer: ReactTestRenderer | null = null
let session: ReturnType<typeof useMobileSessionDiffComments> | null = null
let review: ReturnType<typeof useMobileDiffReviewCommentActions> | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  session = null
  review = null
})

function host(initial: DiffComment[] = [note('A')]) {
  let meta: WorktreeMeta | undefined = mergeWorktreeMetaForWrite(undefined, {
    diffComments: initial
  })
  const client: RpcClient = {
    ...createFakeRpcClient(),
    sendRequest: async (method, params) => {
      if (method === 'worktree.set') {
        try {
          const parsed = WorktreeSet.parse(params)
          meta = mergeWorktreeMetaForWrite(meta, {
            diffComments: parsed.diffComments,
            diffCommentsBase: parsed.diffCommentsBase
          })
        } catch (error) {
          return {
            id: 'reply',
            ok: false,
            error: { code: 'runtime_error', message: String(error) }
          }
        }
      } else if (method !== 'worktree.show') {
        throw new Error(`Unexpected method ${method}`)
      }
      return { id: 'reply', ok: true, result: { worktree: meta }, _meta: { runtimeId: 'host' } }
    }
  }
  return {
    client,
    write: (diffComments: DiffComment[]) => {
      meta = mergeWorktreeMetaForWrite(meta, { diffComments })
    },
    notes: () => meta?.diffComments ?? []
  }
}

function SessionHarness({ client }: { client: RpcClient }) {
  const [diffComments, setDiffComments] = useState<DiffComment[]>([])
  const [diffCommentBusy, setDiffCommentBusy] = useState(false)
  const diffCommentsRef = useRef(diffComments)
  diffCommentsRef.current = diffComments
  const scope: Parameters<typeof useMobileSessionDiffComments>[0] = {
    worktreeId: 'workspace',
    isFloatingWorkspaceRoute: false,
    client,
    connState: 'connected',
    setDiffComments,
    diffCommentsRef,
    diffCommentBusy,
    setDiffCommentBusy,
    setPendingDiffNotesDelivery: vi.fn(),
    showToast: vi.fn()
  }
  session = useMobileSessionDiffComments(scope)
  return null
}

function ReviewHarness({ client }: { client: RpcClient }) {
  const [screenState, setScreenState] = useState<ReviewScreenState>({
    kind: 'ready',
    status: { entries: [], conflictOperation: 'none' },
    branchCompare: null,
    comments: [note('A')],
    reviewState: { version: 1, files: {} }
  })
  review = useMobileDiffReviewCommentActions({
    client,
    connState: 'connected',
    worktreeId: 'workspace',
    screenState,
    currentItem: null,
    queue: [],
    filteredQueue: [],
    filter: 'all',
    currentIndex: 0,
    composer: null,
    composerBody: '',
    setScreenState,
    setCurrentIndex: vi.fn(),
    setComposerBody: vi.fn(),
    setActionError: vi.fn(),
    sheets: { openSheet: vi.fn(), openSheetWhenIdle: vi.fn(), closeSheet: vi.fn() }
  })
  return null
}

describe('mobile note writes preserve changes made on another client', () => {
  it('session deletion accepts the exact persisted body and selection without a false conflict', async () => {
    const original = {
      ...note('A'),
      body: '  preserved user spacing  ',
      source: 'markdown' as const,
      selectedText: '  selected text\n'
    }
    const desktop = host([original])
    await act(async () => {
      renderer = create(createElement(SessionHarness, { client: desktop.client }))
    })
    await act(async () => {
      await session?.deleteDiffCommentForFile('A')
    })
    expect(desktop.notes()).toEqual([])
  })

  it('session deletion still refuses a concurrent whitespace-only body edit', async () => {
    const desktop = host()
    await act(async () => {
      renderer = create(createElement(SessionHarness, { client: desktop.client }))
    })
    desktop.write([{ ...note('A'), body: ' A ' }])
    await act(async () => {
      await session?.deleteDiffCommentForFile('A')
    })
    expect(desktop.notes()).toEqual([{ ...note('A'), body: ' A ' }])
  })

  it('session add retains a note added on desktop after the phone loaded', async () => {
    const desktop = host()
    await act(async () => {
      renderer = create(createElement(SessionHarness, { client: desktop.client }))
    })
    desktop.write([note('A'), note('B')])
    await act(async () => {
      await session?.addDiffCommentForFile('README.md', 2, 'Phone note')
    })
    expect(desktop.notes().map((n) => n.body)).toEqual(['A', 'B', 'Phone note'])
  })

  it('session add does not revive a note deleted on desktop', async () => {
    const desktop = host()
    await act(async () => {
      renderer = create(createElement(SessionHarness, { client: desktop.client }))
    })
    desktop.write([])
    await act(async () => {
      await session?.addDiffCommentForFile('README.md', 2, 'Phone note')
    })
    expect(desktop.notes().map((n) => n.body)).toEqual(['Phone note'])
  })

  it('dedicated review deletion retains unrelated desktop additions', async () => {
    const desktop = host()
    await act(async () => {
      renderer = create(createElement(ReviewHarness, { client: desktop.client }))
    })
    desktop.write([note('A'), note('B')])
    await act(async () => {
      await review?.saveCommentsAndReviewState([], { version: 1, files: {} })
    })
    expect(desktop.notes()).toEqual([note('B')])
  })

  it('saving review progress does not restore desktop-deleted notes', async () => {
    const desktop = host()
    await act(async () => {
      renderer = create(createElement(ReviewHarness, { client: desktop.client }))
    })
    desktop.write([])
    await act(async () => {
      await review?.saveCommentsAndReviewState([note('A')], {
        version: 1,
        files: {},
        completedAt: 1000
      })
    })
    expect(desktop.notes()).toEqual([])
  })
})
