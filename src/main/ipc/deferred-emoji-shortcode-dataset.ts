import { createRequire } from 'node:module'
import type { EmojiShortcodeDataset } from '../../shared/emoji-shortcode-catalog'

// Why createRequire (same reason as linear-sdk.ts): a static import inlines the 166 KB
// shortcode dataset into out/main/index.js and JSON.parses it on every launch, while only
// worktree-name sanitization ever reads it. app.asar ships no node_modules, so this bare require
// resolves out of Resources/node_modules — electron-builder.config.cjs copies exactly this file
// there (the package root is 49 MB of locale data).
const requireFromMain = createRequire(__filename)

export function requireEmojiShortcodeDataset(): EmojiShortcodeDataset {
  return requireFromMain('emojibase-data/en/shortcodes/emojibase.json') as EmojiShortcodeDataset
}
