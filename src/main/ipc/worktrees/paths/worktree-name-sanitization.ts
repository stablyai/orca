import {
  containsEmoji,
  replaceKnownEmojiWithShortcodes,
  setEmojiShortcodeDatasetLoader
} from '../../../../shared/text/emoji-shortcode-catalog'
import { requireEmojiShortcodeDataset } from './deferred-emoji-shortcode-dataset'

setEmojiShortcodeDatasetLoader(requireEmojiShortcodeDataset)

// Why: NFC reorders a mark run in quadratic time; real text stays within Unicode's 30-mark stream-safe limit.
const MAX_COMPOSED_MARK_RUN_LENGTH = 64

function sanitizeNameSegment(input: string): string {
  // Why: vowel signs, viramas and accents are combining marks that belong to their letter; NFC makes a
  // decomposed run match the bytes macOS Git (precomposeunicode) and Linux Git both store.
  return input
    .replace(/(\P{M})\p{M}+/gu, (run, base) =>
      run.length > MAX_COMPOSED_MARK_RUN_LENGTH ? `${base}-` : run.normalize('NFC')
    )
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}._-]+|(?=\p{M})\p{Default_Ignorable_Code_Point}/gu, '-')
    .replace(/(^|[._-])\p{M}+/gu, '$1')
    .replace(/-+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
}

export function sanitizeWorktreeBranchName(input: string): string {
  const sanitized = replaceKnownEmojiWithShortcodes(input)
    .split('/')
    .map(sanitizeNameSegment)
    .filter(Boolean)
    .join('/')
  return sanitized || sanitizeWorktreeName(input)
}

export function sanitizeWorktreeName(input: string): string {
  // Preserve Unicode letters/numbers: Git permits them and workspace names must support users' languages.
  const sanitized = sanitizeNameSegment(replaceKnownEmojiWithShortcodes(input))

  if (!sanitized && containsEmoji(input)) {
    return 'workspace'
  }

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid worktree name')
  }

  return sanitized
}
