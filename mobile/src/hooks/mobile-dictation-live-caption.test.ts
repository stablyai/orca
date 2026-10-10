import { describe, expect, it } from 'vitest'
import { MobileDictationLiveCaptionTracker } from './mobile-dictation-live-caption'

describe('MobileDictationLiveCaptionTracker', () => {
  it('shows each newer caption and ignores replies that arrive late', () => {
    const tracker = new MobileDictationLiveCaptionTracker()
    expect(tracker.accept('d1', { text: 'hello', revision: 1 })).toBe('hello')
    expect(tracker.accept('d1', { text: 'hello world', revision: 3 })).toBe('hello world')
    expect(tracker.accept('d1', { text: 'hello wor', revision: 2 })).toBeNull()
    expect(tracker.accept('d1', { text: 'hello world', revision: 3 })).toBeNull()
  })

  it('skips a newer revision whose text did not change', () => {
    const tracker = new MobileDictationLiveCaptionTracker()
    tracker.accept('d1', { text: 'same', revision: 1 })
    expect(tracker.accept('d1', { text: ' same ', revision: 2 })).toBeNull()
  })

  it('starts a fresh revision sequence for the next dictation', () => {
    const tracker = new MobileDictationLiveCaptionTracker()
    tracker.accept('d1', { text: 'first take', revision: 9 })
    expect(tracker.accept('d2', { text: 'second', revision: 1 })).toBe('second')
  })

  it('shows a repeated phrase again when it opens the next dictation', () => {
    const tracker = new MobileDictationLiveCaptionTracker()
    tracker.accept('d1', { text: 'hello', revision: 1 })
    expect(tracker.accept('d2', { text: 'hello', revision: 1 })).toBe('hello')
  })

  it('accepts an emptied caption on a newer revision so a cleared interim clears the phone', () => {
    const tracker = new MobileDictationLiveCaptionTracker()
    tracker.accept('d1', { text: 'maybe', revision: 1 })
    expect(tracker.accept('d1', { text: '', revision: 2 })).toBe('')
  })
})
