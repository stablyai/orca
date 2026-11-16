import { expect, it } from 'vitest'
import { findMobileDiffLineAnchors } from './mobile-diff-line-anchors'

it('keeps unique nonblank anchors in order when lines move or repeat', () => {
  expect(
    findMobileDiffLineAnchors(
      ['moved', '', '  ', 'repeated', 'first', 'second', 'third', 'repeated'],
      ['first', 'second', 'moved', '', '  ', 'repeated', 'third', 'repeated']
    )
  ).toEqual([
    { originalIndex: 4, modifiedIndex: 0 },
    { originalIndex: 5, modifiedIndex: 1 },
    { originalIndex: 6, modifiedIndex: 6 }
  ])
})
