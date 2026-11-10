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

/** How Claude's permission dialog closed, from the lines it leaves at the bottom of the screen. */
export type ClaudePermissionCloseEvidence = 'hook-denied' | 'user-interrupted' | 'auto-denied'

// Why the bottom lines only: an older prompt's close stays in scrollback above the newest one.
const CLOSE_EVIDENCE_LINES = 10
const CLOSE_EVIDENCE: readonly [RegExp, ClaudePermissionCloseEvidence][] = [
  [/Denied by PermissionRequest hook/, 'hook-denied'],
  // Why String.raw: the orcad bundle must stay ASCII (see CURSORED_OPTION_RE).
  [new RegExp(String.raw`Interrupted \u00B7 What should Claude do instead\?`), 'user-interrupted'],
  [/denied by a built-in Claude Code safety check/, 'auto-denied']
]

export function claudePermissionCloseEvidence(
  lines: readonly string[]
): ClaudePermissionCloseEvidence | null {
  const bottom = lines.filter((line) => line.trim() !== '').slice(-CLOSE_EVIDENCE_LINES)
  for (const [pattern, evidence] of CLOSE_EVIDENCE) {
    if (bottom.some((line) => pattern.test(line))) {
      return evidence
    }
  }
  return null
}

/** Claude's dialog left with the hook's answer applied: a deny shows the hook's line, and an allow
 *  shows no other close. A person's Yes looks the same as the hook's allow. */
export function claudeShowsHookAnswer(
  lines: readonly string[],
  decision: 'allow' | 'deny'
): boolean {
  if (showsClaudeDialog(lines)) {
    return false
  }
  const evidence = claudePermissionCloseEvidence(lines)
  return evidence === 'hook-denied' || (decision === 'allow' && evidence === null)
}
