const CODEX_HEADER_LOADING_RE = /(?:model|directory):\s+loading/
const CODEX_COMPOSER_TEXT_RE = /(?:ask codex to do anything|ask a follow-up question)/i
const CODEX_GARBLED_COMPOSER_RE = /^\s*[›>]\s*\??\S*shortcuts\b.*\banything\b/i
const CODEX_ACTIVE_TURN_RE =
  /^\s*[│|]?\s*[•✻*]\s*(?:working|thinking|generating|planning|executing|running)\b.*(?:esc to interrupt|\(\s*\d+(?:\.\d+)?\s*(?:ms|s|m)\b)/i
const CODEX_COMPLETED_TURN_RE = /\b(?:completed|done|finished|earlier)\b/i

export type CodexScreenReadiness = 'ready' | 'blocked' | 'pending' | 'unknown'

export function isCodexComposerLine(line: string): boolean {
  const withoutBorders = line
    .replace(/^\s*[│|]\s?/, '')
    .replace(/\s*[│|]\s*$/, '')
    .trim()
  return /^›\s*(?:ask codex to do anything|ask a follow-up question)\s*$/i.test(withoutBorders)
}

/**
 * The 80x24 projection can lose the Codex banner and splice the composer into adjacent cells.
 * Keep only a strong composer-shaped fragment as fallback evidence; a generic historical `›`
 * transcript row must not authorize retained ready text.
 */
export function hasCodexComposerEvidence(screenLines: readonly string[]): boolean {
  return screenLines.some(
    (line) => isCodexComposerLine(line) || CODEX_GARBLED_COMPOSER_RE.test(line)
  )
}

export function findCodexComposerLineIndex(lines: readonly string[]): number {
  return lines.findLastIndex(isCodexComposerLine)
}

function findCodexHeaderBottomIndex(lines: readonly string[], headerLineIndex: number): number {
  return lines.findIndex((line, index) => index > headerLineIndex && line.includes('╰'))
}

export function findCodexReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('openai codex')
  if (headerIndex === -1) {
    return null
  }
  const readySegment = normalized.slice(headerIndex)
  // Why: Codex prints permissions only in YOLO mode; the stable ready header is OpenAI Codex + model + directory.
  return readySegment.includes('model:') && readySegment.includes('directory:') ? headerIndex : null
}

// Why the header box only: chat below it can mention OpenAI Codex or model loading.
// Why loading: a header still loading is not ready; the screen must not add readiness early.
export function findCodexScreenReadyPromptIndex(screen: string): number | null {
  if (hasCodexQuotedComposer(screen)) {
    return null
  }
  const headerIndex = screen.indexOf('openai codex')
  if (headerIndex === -1) {
    return null
  }
  const boxEnd = screen.indexOf('╰', headerIndex)
  const header = screen.slice(headerIndex, boxEnd === -1 ? undefined : boxEnd)
  return header.includes('model:') &&
    header.includes('directory:') &&
    !CODEX_HEADER_LOADING_RE.test(header)
    ? headerIndex
    : null
}

export function hasCodexLoadingHeader(screen: string): boolean {
  const headerIndex = screen.indexOf('openai codex')
  if (headerIndex === -1) {
    return false
  }
  const boxEnd = screen.indexOf('╰', headerIndex)
  const header = screen.slice(headerIndex, boxEnd === -1 ? undefined : boxEnd)
  return CODEX_HEADER_LOADING_RE.test(header)
}

export function findCodexComposerScreenReadyPromptIndex(
  normalized: string,
  allowBannerless = false
): number | null {
  const lines = normalized.split('\n')
  const composerLineIndex = findCodexComposerLineIndex(lines)
  const headerLineIndex = lines.findIndex((line) => line.includes('openai codex'))
  const headerBottomIndex =
    headerLineIndex === -1 ? -1 : findCodexHeaderBottomIndex(lines, headerLineIndex)
  const headerTopIndex =
    headerLineIndex === -1
      ? -1
      : lines.slice(0, headerLineIndex + 1).findLastIndex((line) => line.includes('╭'))
  if (composerLineIndex === -1) {
    return null
  }
  if (headerLineIndex === -1 && !allowBannerless) {
    return null
  }
  // Why the frame: a quoted OpenAI Codex line in chat is not the running Codex header.
  if (headerLineIndex !== -1) {
    if (headerTopIndex === -1 || headerBottomIndex === -1 || headerTopIndex > headerLineIndex) {
      return null
    }
    if (composerLineIndex <= headerBottomIndex) {
      return null
    }
    const header = lines.slice(headerTopIndex, headerBottomIndex + 1).join('\n')
    if (CODEX_HEADER_LOADING_RE.test(header)) {
      return null
    }
  }
  if (hasCodexActiveTurnInCurrentScreen(normalized)) {
    return null
  }
  return lines.slice(0, composerLineIndex).reduce((offset, line) => offset + line.length + 1, 0)
}

export function hasCodexActiveTurn(normalized: string): boolean {
  return normalized
    .split('\n')
    .some((line) => CODEX_ACTIVE_TURN_RE.test(line) && !CODEX_COMPLETED_TURN_RE.test(line))
}

export function hasCodexActiveTurnInCurrentScreen(normalized: string): boolean {
  const lines = normalized.split('\n')
  const composerLineIndex = findCodexComposerLineIndex(lines)
  // An uncompleted Working/Thinking row is a live provider veto even when a later prompt-shaped
  // row and the composer are also painted. Only explicit completion markers make old history
  // safe to ignore; the screen has no stronger turn watermark.
  return hasCodexActiveTurn(
    composerLineIndex === -1 ? normalized : lines.slice(0, composerLineIndex).join('\n')
  )
}

export function hasCodexQuotedComposer(normalized: string): boolean {
  const lines = normalized.split('\n')
  const composerLineIndex = findCodexComposerLineIndex(lines)
  return lines.some(
    (line, index) =>
      CODEX_COMPOSER_TEXT_RE.test(line) &&
      (composerLineIndex === -1 || index !== composerLineIndex) &&
      !isCodexComposerLine(line) &&
      // A history line before the real current composer is harmless. When no exact composer is
      // rendered, the same phrase is the only evidence and must remain a veto.
      (composerLineIndex === -1 || index > composerLineIndex)
  )
}

/**
 * Classifies only the currently rendered Codex grid. A returned `unknown` deliberately permits
 * the legacy text preview fallback during a repaint-sized/garbled grid; every visible Codex
 * state that can be identified is fail-closed.
 */
export function classifyCodexScreenReadiness(
  screenLines: readonly string[],
  currentComposerSignal: boolean,
  hasVisibleBlocker: (screen: string) => boolean
): CodexScreenReadiness {
  const screen = screenLines.join('\n').toLowerCase()
  if (hasVisibleBlocker(screen)) {
    return 'blocked'
  }
  if (hasCodexLoadingHeader(screen)) {
    return 'pending'
  }
  if (hasCodexQuotedComposer(screen) || hasCodexActiveTurnInCurrentScreen(screen)) {
    return 'pending'
  }
  const exactComposer = findCodexComposerScreenReadyPromptIndex(screen, true)
  const hasExactComposer = screenLines.some((line) => isCodexComposerLine(line))
  const headerIndex = screen.indexOf('openai codex')
  const headerIsFramed =
    headerIndex === -1 ||
    (screen.lastIndexOf('╭', headerIndex) !== -1 && screen.includes('╰', headerIndex))
  if (hasExactComposer && !screen.includes('openai codex') && !currentComposerSignal) {
    return 'pending'
  }
  if (hasExactComposer && !headerIsFramed && !currentComposerSignal) {
    return 'pending'
  }
  if (!hasExactComposer && headerIndex !== -1 && !headerIsFramed) {
    // An unframed header can be retained history. A scanner signal authorizes only a visible
    // composer; it must never settle a header-only screen, even when the text preview matches.
    return 'pending'
  }
  if (
    findCodexScreenReadyPromptIndex(screen) !== null ||
    findCodexComposerScreenReadyPromptIndex(screen, currentComposerSignal) !== null
  ) {
    return 'ready'
  }
  if (hasExactComposer && exactComposer === null) {
    // This includes a bannerless composer without the fresh PTY scanner watermark.
    return 'pending'
  }
  return 'unknown'
}
