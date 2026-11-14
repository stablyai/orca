import { isUnblockedAfter } from './blocked-text-layer'
import {
  lastSupportedIndex,
  supportedRegexMatches
} from '../../../shared/terminal/output/terminal-supported-occurrences'
import {
  offsetTerminalSupport,
  type TerminalSupportQuery
} from '../../../shared/terminal/output/terminal-content-origin'

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
function findCodexHeader(
  screen: string,
  support?: TerminalSupportQuery
): { index: number; text: string } | null {
  let index = screen.indexOf('openai codex')
  while (index !== -1 && support && !support(index, index + 'openai codex'.length)) {
    index = screen.indexOf('openai codex', index + 1)
  }
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
export function isCodexHeaderReadyScreen(screen: string, support?: TerminalSupportQuery): boolean {
  const header = findCodexHeader(screen, support)
  const query = offsetTerminalSupport(support, header?.index ?? 0)
  return (
    header !== null &&
    lastSupportedIndex(header.text, 'model:', query) !== -1 &&
    lastSupportedIndex(header.text, 'directory:', query) !== -1 &&
    supportedRegexMatches(header.text, CODEX_HEADER_LOADING_RE, query).length === 0 &&
    isUnblockedAfter(screen, header.index, support)
  )
}

/** 0.158 lacks model/directory headers; long sessions can scroll the header away.
 * Dialogs replace the composer, so quoted questions must not block it. Mid-turn safety relies on quiescence;
 * tui.animations=false, tui.effects.progress=false or a tui.terminal_title without activity/spinner removes it. */
export function isCodexComposerReadyScreen(
  screen: string,
  support?: TerminalSupportQuery
): boolean {
  const lines = screen.split('\n')
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  const composer = lines.findLastIndex(
    (line, row) =>
      supportedRegexMatches(
        line,
        CODEX_EMPTY_COMPOSER_RE,
        offsetTerminalSupport(support, offsets[row]!)
      ).length > 0
  )
  if (composer === -1 || hasBusyStatusRowAbove(lines, composer, offsets, support)) {
    return false
  }
  const header = findCodexHeader(screen, support)
  return (
    header === null ||
    supportedRegexMatches(
      header.text,
      CODEX_HEADER_LOADING_RE,
      offsetTerminalSupport(support, header.index)
    ).length === 0
  )
}

// Earlier answers can quote the busy marker; inspect only the adjacent status row.
function hasBusyStatusRowAbove(
  lines: readonly string[],
  composer: number,
  offsets: readonly number[],
  support?: TerminalSupportQuery
): boolean {
  const above = lines.slice(0, composer).flatMap((line, row) => (line.trim() ? [row] : []))
  const last = above.at(-1)
  const row =
    last !== undefined &&
    lines[last]?.trimStart().startsWith(CODEX_STATUS_TIP_PREFIX) &&
    lastSupportedIndex(
      lines[last]!,
      CODEX_STATUS_TIP_PREFIX,
      offsetTerminalSupport(support, offsets[last]!)
    ) !== -1
      ? above.at(-2)
      : last
  return (
    row !== undefined &&
    lastSupportedIndex(
      lines[row]!,
      CODEX_BUSY_STATUS_MARKER,
      offsetTerminalSupport(support, offsets[row]!)
    ) !== -1
  )
}
