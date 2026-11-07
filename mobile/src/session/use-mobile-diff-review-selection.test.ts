import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import { useMobileDiffReviewSelection } from './use-mobile-diff-review-selection'

function unstaged(filePath: string): MobileDiffReviewQueueItem {
  return {
    key: `unstaged\0unstaged\0\0${filePath}`,
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

const committedFiles: (string | null)[] = []
let tree: ReactTestRenderer | null = null

function Probe({ queue }: { queue: readonly MobileDiffReviewQueueItem[] }) {
  const { currentItem } = useMobileDiffReviewSelection(queue, {
    area: 'unstaged',
    filePath: 'c.ts'
  })
  const filePath = currentItem?.filePath ?? null
  useEffect(() => {
    committedFiles.push(filePath)
  }, [filePath])
  return null
}

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  committedFiles.length = 0
})

it('opens on the tapped file without ever making the first file current', async () => {
  await act(async () => {
    tree = create(createElement(Probe, { queue: [] }))
  })
  await act(async () => {
    tree?.update(
      createElement(Probe, { queue: [unstaged('a.ts'), unstaged('b.ts'), unstaged('c.ts')] })
    )
  })
  expect(committedFiles).toEqual([null, 'c.ts'])
})
