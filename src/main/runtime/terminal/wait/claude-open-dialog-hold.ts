import {
  terminalScreenSupport,
  type TerminalContentOrigin,
  type TerminalScreenSupportQuery
} from '../../../../shared/terminal/output/terminal-content-origin'
import { supportedRegexMatches } from '../../../../shared/terminal/output/terminal-supported-occurrences'
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
function hasCursoredOptionList(
  lines: readonly string[],
  support?: TerminalScreenSupportQuery
): boolean {
  return lines.some(
    (line, index) =>
      matchesDialogRow(line, CURSORED_OPTION_RE, index, support) &&
      (matchesDialogRow(lines[index - 1] ?? '', OPTION_RE, index - 1, support) ||
        matchesDialogRow(lines[index + 1] ?? '', OPTION_RE, index + 1, support))
  )
}

/** Claude keeps its rest-glyph title during dialogs without OSC 7501; Esc emits no dismissal hook.
 * Trust readable screen evidence and cap otherwise-unretired hook rows. */
export function isClaudeDialogHoldingPane(args: {
  row: AgentStatusIpcPayload | null
  respawnedAt: number | undefined
  readScreenLines: () => readonly string[] | null
  contentScope?: TerminalContentOrigin
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
  return lines === null || showsClaudeDialog(lines, args.contentScope)
}

function matchesDialogRow(
  line: string,
  pattern: RegExp,
  row: number,
  support?: TerminalScreenSupportQuery
): boolean {
  return (
    supportedRegexMatches(
      line,
      pattern,
      support ? (start, end) => support(row, start, end) : undefined
    ).length > 0
  )
}

export function showsClaudeDialog(
  lines: readonly string[],
  scope?: TerminalContentOrigin
): boolean {
  const rows = lines
    .flatMap((line, index) => (line.trim() ? [index] : []))
    .slice(-DIALOG_REGION_LINES)
  const region = rows.map((index) => lines[index]!)
  const query = terminalScreenSupport(lines, scope)
  const support: TerminalScreenSupportQuery | undefined = query
    ? (row, start, end) => query(rows[row] ?? -1, start, end)
    : undefined
  return (
    region.some((line, row) => matchesDialogRow(line, DIALOG_FOOTER_RE, row, support)) ||
    hasCursoredOptionList(region, support)
  )
}

// Claude's permission dialog: "Claude Code will automatically block this request in 1:59, ...".
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

// Why String.raw: the orcad bundle must stay ASCII (see CURSORED_OPTION_RE).
const DASHED_RULE_RE = new RegExp(String.raw`^\s*\u254C`)
const BOX_LINE_RE = new RegExp(String.raw`^\s*\u2502 ?`)
const PROCEED_RE = /Do you want to proceed\?/

/** The warning Claude prints under a command it flagged, the paragraph after the command's own
 *  dashed box and before the countdown; null when the dialog has none. */
export function claudeDialogWarning(lines: readonly string[] | null): string | null {
  const region = (lines ?? []).filter((row) => row.trim() !== '').slice(-DIALOG_REGION_LINES * 2)
  const proceed = region.findLastIndex((line) => PROCEED_RE.test(line))
  const rules = region
    .slice(0, Math.max(proceed, 0))
    .flatMap((line, index) => (DASHED_RULE_RE.test(line) ? [index] : []))
  // A warning follows the rule that closes the command's box: the last one. A long command
  // scrolls the rule that opens the box off the screen, so only the closing one may show.
  if (proceed === -1 || rules.length === 0) {
    return null
  }
  const warning = region
    .slice((rules.at(-1) ?? 0) + 1, proceed)
    .filter((line) => BOX_LINE_RE.test(line))
    .map((line) => line.replace(BOX_LINE_RE, '').trim())
    .join(' ')
  return warning || null
}
