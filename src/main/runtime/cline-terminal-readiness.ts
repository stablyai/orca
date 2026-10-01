const CLINE_RULE_RE = /^─{8,}$/
// Captured placeholders: startup (Act), after a turn (Act), and Plan mode.
const CLINE_EMPTY_COMPOSERS: ReadonlySet<string> = new Set([
  '❯ what can i do for you?',
  '❯ ask anything...',
  '❯ plan something...'
])
const CLINE_MODE_ROW_RE = /[○●] plan [○●] act \(tab\)$/
const BRAILLE_SPINNER_RE = /[⠀-⣿]/

/**
 * Cline 3.0.x's empty composer box with its Plan/Act status rows under it.
 * Why it proves only that the composer is up: Cline repaints the same box while a reply streams
 * and its spinner row has scrolled away, so callers must also require a quiet stream.
 */
export function isClineComposerReadyScreen(screenLines: readonly string[]): boolean {
  const lines = screenLines.map((line) => line.trim().toLowerCase())
  const modeRow = lines.findLastIndex((line) => CLINE_MODE_ROW_RE.test(line))
  // Why bounded: the mode row sits above the cwd and auto-approve rows, never higher.
  if (modeRow < 3 || modeRow < lines.length - 3) {
    return false
  }
  return (
    CLINE_RULE_RE.test(lines[modeRow - 1]) &&
    CLINE_EMPTY_COMPOSERS.has(lines[modeRow - 2]) &&
    CLINE_RULE_RE.test(lines[modeRow - 3]) &&
    !lines.slice(0, modeRow - 3).some((line) => BRAILLE_SPINNER_RE.test(line))
  )
}
