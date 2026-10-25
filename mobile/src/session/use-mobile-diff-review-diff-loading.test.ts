import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { ConnectionState } from '../transport/types'
import { buildMobileDiffReviewQueue } from './mobile-diff-review-queue'
import type { ReviewDiffState, ReviewScreenState } from './mobile-diff-review-screen-model'
import { useMobileDiffReviewDiffLoading } from './use-mobile-diff-review-diff-loading'

const loadDiff = vi.hoisted(() => vi.fn())
vi.mock('./mobile-diff-review-loaders', () => ({ loadMobileDiffReviewDiff: loadDiff }))

const client = createFakeRpcClient()
const currentItem = buildMobileDiffReviewQueue({
  worktreeId: 'wt-1',
  statusEntries: [{ path: 'src/app.ts', status: 'modified', area: 'unstaged' }],
  branchEntries: [],
  comments: [],
  reviewState: { version: 1, files: {} }
})[0]!
const readyScreen: ReviewScreenState = {
  kind: 'ready',
  branchCompare: null,
  status: {
    entries: [],
    conflictOperation: undefined,
    branch: undefined,
    head: undefined,
    upstreamStatus: undefined
  },
  comments: [],
  reviewState: { version: 1, files: {} }
}

function readyDiff(firstLine: string): ReviewDiffState {
  return {
    kind: 'ready',
    itemKey: currentItem.key,
    lines: [
      {
        kind: 'add',
        newLineNumber: 1,
        text: firstLine,
        segments: [{ text: firstLine, kind: 'plain' }],
        highlighted: false
      }
    ],
    hunks: [
      { index: 0, startIndex: 0, endIndex: 0, addedLines: 1, deletedLines: 0, firstLineNumber: 1 }
    ],
    truncated: false
  }
}

describe('useMobileDiffReviewDiffLoading', () => {
  let renderer: ReactTestRenderer | null = null
  let diffState: ReviewDiffState = { kind: 'idle' }
  let activeHunkIndex: number | null = null
  let selectHunk: ((index: number | null) => void) | null = null

  function Probe({ connState }: { connState: ConnectionState }): null {
    const [selectedHunk, setActiveHunkIndex] = useState<number | null>(null)
    activeHunkIndex = selectedHunk
    selectHunk = setActiveHunkIndex
    diffState = useMobileDiffReviewDiffLoading({
      client,
      connState,
      worktreeId: 'wt-1',
      currentItem,
      screenState: readyScreen,
      setActiveHunkIndex
    })
    return null
  }

  async function render(connState: ConnectionState): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Probe, { connState }))
      await Promise.resolve()
    })
  }

  async function update(connState: ConnectionState): Promise<void> {
    await act(async () => {
      renderer?.update(createElement(Probe, { connState }))
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    loadDiff.mockReset()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('keeps the loaded diff when the reconnect refetch rejects', async () => {
    loadDiff
      .mockResolvedValueOnce(readyDiff('before the drop'))
      .mockRejectedValueOnce(new Error('diff fetch failed'))

    await render('connected')
    expect(diffState).toMatchObject({ kind: 'ready' })
    act(() => selectHunk?.(0))
    expect(activeHunkIndex).toBe(0)

    await update('reconnecting')
    await update('connected')
    // Why (F10): a failed refetch must not erase the diff (or hunk context) on screen.
    expect(diffState).toMatchObject({ kind: 'ready', lines: [{ text: 'before the drop' }] })
    expect(loadDiff).toHaveBeenCalledTimes(2)
    expect(activeHunkIndex).toBe(0)
  })

  it('keeps the loaded diff through a disconnect and its reconnect refetch', async () => {
    let releaseRefetch: (() => void) | null = null
    loadDiff.mockResolvedValueOnce(readyDiff('before the drop')).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRefetch = () => resolve(readyDiff('after the drop'))
        })
    )

    await render('connected')
    expect(diffState).toMatchObject({ kind: 'ready' })
    act(() => selectHunk?.(0))
    expect(activeHunkIndex).toBe(0)

    await update('reconnecting')
    expect(diffState).toMatchObject({ kind: 'ready', lines: [{ text: 'before the drop' }] })

    await update('connected')
    expect(diffState).toMatchObject({ kind: 'ready', lines: [{ text: 'before the drop' }] })

    await act(async () => {
      releaseRefetch?.()
      await Promise.resolve()
    })
    expect(diffState).toMatchObject({ kind: 'ready', lines: [{ text: 'after the drop' }] })
    expect(loadDiff).toHaveBeenCalledTimes(2)
    expect(activeHunkIndex).toBe(0)
  })

  it('waits for the desktop when the drop lands before any diff is loaded', async () => {
    loadDiff.mockReturnValueOnce(new Promise(() => {}))

    await render('connected')
    expect(diffState).toMatchObject({ kind: 'loading', itemKey: currentItem.key })

    await update('disconnected')
    expect(diffState).toMatchObject({ kind: 'error', message: 'Waiting for desktop...' })
  })
})
