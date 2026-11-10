import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'

// Why a cap: Esc posts no hook, so a dismissed dialog's row can outlive it; a draft can be abandoned.
export const USER_INPUT_HOLD_CAP_MS = 10 * 60_000
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

/** Claude keeps its rest-glyph title during dialogs without OSC 7501; Esc emits no dismissal hook.
 * Trust readable screen evidence and cap otherwise-unretired hook rows. */
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
    (args.now ?? Date.now()) - row.receivedAt > USER_INPUT_HOLD_CAP_MS
  ) {
    return false
  }
  const lines = args.readScreenLines()
  return lines === null || showsClaudeDialog(lines)
}

export function showsClaudeDialog(lines: readonly string[]): boolean {
  const region = lines.filter((line) => line.trim() !== '').slice(-DIALOG_REGION_LINES)
  return region.some((line) => DIALOG_FOOTER_RE.test(line)) || hasCursoredOptionList(region)
}

// Claude's permission dialog: "Claude Code will automatically block this request in 1:59, …".
const AUTO_BLOCK_COUNTDOWN_RE = /automatically block this request in (\d+):(\d{2})/

/** When the dialog's own auto-block countdown runs out, if the screen shows one. */
export function claudeDialogExpiresAt(
  lines: readonly string[] | null,
  now: number
): string | undefined {
  for (const line of (lines ?? []).filter((row) => row.trim() !== '').slice(-DIALOG_REGION_LINES)) {
    const match = AUTO_BLOCK_COUNTDOWN_RE.exec(line)
    if (match) {
      return new Date(now + (Number(match[1]) * 60 + Number(match[2])) * 1_000).toISOString()
    }
  }
  return undefined
}
