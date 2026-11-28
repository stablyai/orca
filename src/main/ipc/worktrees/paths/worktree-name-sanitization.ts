import { escapeWindowsDeviceName } from '../../../../shared/browser/downloads/browser-download-filename'
import { wslDistroForCommand } from '../../../../shared/file-access/wsl-paths'
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

/** WSL-backed repos keep device names: only Git for Windows rejects them, distro Git does not. */
export function getWorktreeNameGitPlatform(
  repoPath: string,
  localWorktreeGitOptions: { wslDistro?: string }
): NodeJS.Platform {
  return wslDistroForCommand(repoPath, localWorktreeGitOptions.wslDistro)
    ? 'linux'
    : process.platform
}

export function sanitizeWorktreeBranchName(
  input: string,
  gitPlatform: NodeJS.Platform = process.platform
): string {
  const sanitized = replaceKnownEmojiWithShortcodes(input)
    .split('/')
    // Why: Git for Windows cannot create a ref file whose path has a segment named like a Windows device.
    .map((segment) => escapeWindowsDeviceName(sanitizeNameSegment(segment), gitPlatform))
    .filter(Boolean)
    .join('/')
  return sanitized || sanitizeWorktreeName(input, gitPlatform)
}

export function sanitizeWorktreeName(
  input: string,
  gitPlatform: NodeJS.Platform = process.platform
): string {
  // Preserve Unicode letters/numbers: Git permits them and workspace names must support users' languages.
  const sanitized = sanitizeNameSegment(replaceKnownEmojiWithShortcodes(input))

  if (!sanitized && containsEmoji(input)) {
    return 'workspace'
  }

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid worktree name')
  }

  // Why: `git worktree add` fails with "Invalid argument" for a folder named like a Windows device.
  return escapeWindowsDeviceName(sanitized, gitPlatform)
}
