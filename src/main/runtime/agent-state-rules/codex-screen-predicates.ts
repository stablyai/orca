import { isUnblockedAfter } from './blocked-text-layer'

// 0.150–0.157 box model: loading; 0.158 shows bare loading below the title.
const CODEX_HEADER_LOADING_RE = /(?:model|directory):\s+loading|^\s*loading\s*$/m
// 0.158 has no box boundary before chat.
const CODEX_HEADER_LINES = 6
// Whole-line matching excludes placeholders quoted in chat/pagers.
const CODEX_EMPTY_COMPOSER_RE = /^\u203A ask codex to do anything\s*$/
// Reasoning summaries replace working; remapped interrupt keys retain this suffix.
const CODEX_BUSY_STATUS_MARKER = 'to interrupt)'
// Only the tip separates status from composer in the 120x40 corpus.
const CODEX_STATUS_TIP_PREFIX = '└ tip:'

// Chat can quote header markers and loading text.
function findCodexHeader(screen: string): { index: number; text: string } | null {
  const index = screen.indexOf('openai codex')
  if (index === -1) {
    return null
  }
  const boxEnd = screen.indexOf('╰', index)
  const text = screen
    .slice(index, boxEnd === -1 ? undefined : boxEnd)
    .split('\n', CODEX_HEADER_LINES)
    .join('\n')
  return { index, text }
}

/** Cell-diff header repaints require the grid; folded text cannot reconstruct them. */
export function isCodexHeaderReadyScreen(screen: string): boolean {
  const header = findCodexHeader(screen)
  return (
    header !== null &&
    header.text.includes('model:') &&
    header.text.includes('directory:') &&
    !CODEX_HEADER_LOADING_RE.test(header.text) &&
    isUnblockedAfter(screen, header.index)
  )
}

/** 0.158 lacks model/directory headers; long sessions can scroll the header away.
 * Dialogs replace the composer, so quoted questions must not block it. Mid-turn safety relies on quiescence;
 * tui.animations=false, tui.effects.progress=false or a tui.terminal_title without activity/spinner removes it. */
export function isCodexComposerReadyScreen(screen: string): boolean {
  const lines = screen.split('\n')
  const composer = lines.findLastIndex((line) => CODEX_EMPTY_COMPOSER_RE.test(line))
  if (composer === -1 || hasBusyStatusRowAbove(lines, composer)) {
    return false
  }
  const header = findCodexHeader(screen)
  return header === null || !CODEX_HEADER_LOADING_RE.test(header.text)
}

// Earlier answers can quote the busy marker; inspect only the adjacent status row.
function hasBusyStatusRowAbove(lines: readonly string[], composer: number): boolean {
  const above = lines.slice(0, composer).filter((line) => line.trim() !== '')
  const row = above.at(-1)?.trimStart().startsWith(CODEX_STATUS_TIP_PREFIX)
    ? above.at(-2)
    : above.at(-1)
  return row?.includes(CODEX_BUSY_STATUS_MARKER) ?? false
}
