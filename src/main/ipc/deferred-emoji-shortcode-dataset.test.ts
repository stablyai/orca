import { describe, expect, it, vi } from 'vitest'
import emojiShortcodes from 'emojibase-data/en/shortcodes/emojibase.json'
import { requireEmojiShortcodeDataset } from './deferred-emoji-shortcode-dataset'

// Keep main imports outside shared tsconfig projects; the lazy catalog test enforces that boundary.
describe('deferred emoji shortcode dataset', () => {
  it('loads the main-side dataset synchronously into an identical catalog', async () => {
    vi.resetModules()
    const eager = await import('../../shared/emoji-shortcode-catalog.js')
    eager.setEmojiShortcodeDatasetLoader(() => emojiShortcodes)
    const eagerEntries = eager.getStandardEmojiShortcodeEntries()
    const eagerTransform = eager.replaceKnownEmojiWithShortcodes('ship \u{1F389} \u{1F44D}')

    vi.resetModules()
    const deferred = await import('../../shared/emoji-shortcode-catalog.js')
    deferred.setEmojiShortcodeDatasetLoader(requireEmojiShortcodeDataset)

    // Immediate use must work without awaiting an async import.
    expect(deferred.getStandardEmojiShortcodeEntries()).toEqual(eagerEntries)
    expect(deferred.replaceKnownEmojiWithShortcodes('ship \u{1F389} \u{1F44D}')).toBe(
      eagerTransform
    )
  })
})
