import {
  containsEmoji,
  replaceKnownEmojiWithShortcodes,
  setEmojiShortcodeDatasetLoader
} from '../../../../shared/text/emoji-shortcode-catalog'
import { requireEmojiShortcodeDataset } from './deferred-emoji-shortcode-dataset'

setEmojiShortcodeDatasetLoader(requireEmojiShortcodeDataset)

function sanitizeNameSegment(input: string): string {
  return input
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
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
