const PRIME_FOOTER_PREFIX = '← manage'
// 0.9.8 paints `Details mode`, 0.9.5 `Collapsed mode`.
const PRIME_VIEW_MODE_HINT_RE = /^\S+ mode \(ctrl\+o to expand\)$/i
const BRAILLE_SPINNER_RE = /[⠀-⣿]/

/**
 * Prime Agent 0.9.5+ at an idle composer: a bare `>` over the `← manage` footer.
 * Why the spinner veto: the footer and the caret both stay painted for a whole turn; only the
 * status row Prime keeps directly above them (`⠦ Writing · 6s`) says a turn is running.
 */
export function isPrimeAgentComposerReadyScreen(screenLines: readonly string[]): boolean {
  const footer = screenLines.at(-1)?.trim() ?? ''
  const composer = screenLines.at(-2)?.trim()
  if (!footer.startsWith(PRIME_FOOTER_PREFIX) || composer !== '>') {
    return false
  }
  let statusIndex = screenLines.length - 3
  if (PRIME_VIEW_MODE_HINT_RE.test(screenLines[statusIndex]?.trim() ?? '')) {
    statusIndex -= 1
  }
  return !BRAILLE_SPINNER_RE.test(screenLines[statusIndex] ?? '')
}
