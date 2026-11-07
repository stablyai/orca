import { createRequire } from 'node:module'
import type { EmojiShortcodeDataset } from '../../shared/emoji-shortcode-catalog'

// Defer the 166KB catalog; packaged require resolves the builder-copied file in Resources/node_modules outside app.asar.
const requireFromMain = createRequire(__filename)

export function requireEmojiShortcodeDataset(): EmojiShortcodeDataset {
  return requireFromMain('emojibase-data/en/shortcodes/emojibase.json') as EmojiShortcodeDataset
}
