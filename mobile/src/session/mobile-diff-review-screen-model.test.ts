import { describe, expect, it } from 'vitest'
import { mobileI18n } from '../i18n/mobile-i18n'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import {
  mobileReviewFilterLabel,
  mobileReviewNoteCountLabel,
  mobileReviewUnsentNoteCountLabel,
  nextReviewIndexAfterMarkReviewed
} from './mobile-diff-review-screen-model'

function item(filePath: string): MobileDiffReviewQueueItem {
  return {
    key: `unstaged\0unstaged\0\0${filePath}`,
    scope: 'unstaged',
    area: 'unstaged',
    filePath,
    status: 'modified',
    title: filePath,
    subtitle: 'Unstaged',
    canStage: true,
    canUnstage: false,
    canDiscard: true,
    isGeneratedOrLockFile: false,
    diffIdentity: `diff:${filePath}`,
    noteCount: 0,
    unsentNoteCount: 0,
    staleNoteCount: 0,
    isReviewed: false,
    changedSinceReview: false
  }
}

describe('mobile diff review screen model', () => {
  it('keeps the next unreviewed file selected after the current file leaves the filter', () => {
    const queue = [item('a.ts'), item('b.ts'), item('c.ts')]

    expect(
      nextReviewIndexAfterMarkReviewed({
        currentIndex: 0,
        currentItemKey: queue[0].key,
        filter: 'unreviewed',
        filteredQueue: queue
      })
    ).toBe(0)
  })

  it('keeps direct next-file indexing for non-removing filters', () => {
    const queue = [item('a.ts'), item('b.ts'), item('c.ts')]

    expect(
      nextReviewIndexAfterMarkReviewed({
        currentIndex: 0,
        currentItemKey: queue[0].key,
        filter: 'all',
        filteredQueue: queue
      })
    ).toBe(1)
  })

  it('localizes review filters and count variants without English fragments', async () => {
    const initialLocale = mobileI18n.language
    await mobileI18n.changeLanguage('es')
    try {
      expect(mobileReviewFilterLabel('unreviewed')).toBe('Sin revisar')
      expect(mobileReviewFilterLabel('unstaged')).toBe('Sin preparar')
      expect(mobileReviewFilterLabel('staged')).toBe('Preparado')
      expect(mobileReviewNoteCountLabel(1)).toBe('1 nota')
      expect(mobileReviewNoteCountLabel(2)).toBe('2 notas')
      expect(mobileReviewUnsentNoteCountLabel(1)).toBe('1 nota no enviada')
    } finally {
      await mobileI18n.changeLanguage(initialLocale)
    }
  })
})
