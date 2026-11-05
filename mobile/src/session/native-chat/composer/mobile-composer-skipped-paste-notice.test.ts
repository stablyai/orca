import { describe, expect, it } from 'vitest'
import { mobileComposerSkippedPasteNotice } from './mobile-composer-skipped-paste-notice'

describe('mobileComposerSkippedPasteNotice', () => {
  it('names how many unsupported files a mixed paste skipped', () => {
    expect(mobileComposerSkippedPasteNotice(1)).toBe('Skipped 1 unsupported file')
    expect(mobileComposerSkippedPasteNotice(2)).toBe('Skipped 2 unsupported files')
  })
})
