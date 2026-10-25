import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

// Why a cap: Esc posts no hook, so a dismissed dialog's row can outlive it on an unreadable screen.
export const CLAUDE_DIALOG_HOLD_CAP_MS = 10 * 60_000
// A dialog is painted at the bottom of the screen; older rows are scrollback.
const DIALOG_REGION_LINES = 14
const DIALOG_FOOTER_RE = /Enter to select|Esc to cancel/
// Why String.raw: the orcad bundle must stay ASCII, and the formatter unescapes regex literals.
const CURSORED_OPTION_RE = new RegExp(String.raw`^\s*\u276F \d+\. `)
const OPTION_RE = /^\s+\d+\. /

/** Plan approval has no footer: its cursored option sits directly above or below another one. */
function hasCursoredOptionList(lines: readonly string[]): boolean {
  return lines.some(
    (line, index) =>
      CURSORED_OPTION_RE.test(line) &&
      (OPTION_RE.test(lines[index - 1] ?? '') || OPTION_RE.test(lines[index + 1] ?? ''))
  )
}

/**
 * Whether a Claude dialog still holds the pane: Claude keeps its rest-glyph title under it, so
 * without OSC 7501 only the hook row shows it. Esc dismisses it without a hook, so the screen
 * decides whenever it can be read, and the cap bounds a row nothing else retires.
 */
export function isClaudeDialogHoldingPane(args: {
  row: AgentStatusIpcPayload | null
  respawnedAt: number | undefined
  readScreenLines: () => readonly string[] | null
  now?: number
}): boolean {
  const { row } = args
  if (
    row?.agentType !== 'claude' ||
    (row.state !== 'waiting' && row.state !== 'blocked') ||
    row.receivedAt < (args.respawnedAt ?? -1) ||
    (args.now ?? Date.now()) - row.receivedAt > CLAUDE_DIALOG_HOLD_CAP_MS
  ) {
    return false
  }
  const lines = args.readScreenLines()
  if (lines === null) {
    return true
  }
  const region = lines.filter((line) => line.trim() !== '').slice(-DIALOG_REGION_LINES)
  return region.some((line) => DIALOG_FOOTER_RE.test(line)) || hasCursoredOptionList(region)
}
