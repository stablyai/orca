import {
  buildNativeChatFolderTrustPrompt,
  buildNativeChatStartupMenuPrompt,
  STARTUP_MENU_DESCRIPTION_MAX,
  type NativeChatStartupMenuChoice
} from '../../../../shared/native-chat/input/native-chat-approval-envelope'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/runtime-terminal-contracts'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { findTerminalWaitBlockedSignal } from '../../agent-state-rules/blocked-text-layer'

// A live dialog ends on its key footer; quoted dialog text in a reply does not.
const TRUST_DIALOG_FOOTER_RE =
  /^(?:enter to confirm \u00b7 esc to cancel|space to select \u00b7 esc to reject all|enter(?:\/esc)? (?:continue|confirm) \u00b7 (?:esc (?:quit|skip)|ctrl\+c quit))$/
const TRUST_REASONS: ReadonlySet<RuntimeTerminalWaitBlockedReason> = new Set([
  'agent-trust-workspace',
  'codex-trust-workspace'
])
// Only dialogs that precede a first prompt and end on a key footer; mid-session approvals have their own cards.
const STARTUP_MENU_REASONS: ReadonlySet<RuntimeTerminalWaitBlockedReason> = new Set([
  'agent-update-prompt',
  'agent-hooks-review-prompt',
  'codex-model-migration-prompt',
  'agent-startup-menu-prompt'
])
// Claude's Ink select: two-space margin, then the cursor or a space, then the label.
const INK_CHOICE_ROW_RE = /^ {2}([\u276f ]) (\S.*?)\s*$/
// Choice counts verified on Claude 2.1.316; a wrapped label adds a row, so a mismatch is not aimable.
const CLAUDE_MENU_CHOICE_COUNTS: readonly (readonly [RegExp, number])[] = [
  [/new mcp server found/, 3],
  [/detected a custom api key/, 2],
  [/running in bypass permissions mode/, 2],
  [/allow external claude\.md file imports/, 2]
]
// Claude's multi-select for several new .mcp.json servers (2.1.322): ticked rows, then the submit row.
const CLAUDE_MCP_SERVERS_HEADING_RE = /^(\d+) new mcp servers found/
const INK_CHECKBOX_ROW_RE = /^ {2}([\u276f ]) \[([\u2714 ])\] (\S.*?)\s*$/
const INK_SUBMIT_ROW_RE = /^ {2}([\u276f ]) {4}(\S.*?)\s*$/
const ESCAPE = '\x1b'
const DIALOG_RULE_RE = /^\u2500+$/
const TRUST_DIALOG_CHOICE_RE =
  /^(?:[\u276f\u203a]\s*)?(?:\d+\.\s*)?(?:yes, i trust this folder|trust and continue)$/
const TRUST_DIALOG_CHOICE_ROWS = 6
const TRUST_DIALOG_CURSOR_RE = /^[\u276f\u203a]/

function normalizedLines(rows: string[]): string[] {
  return rows.map((line) => line.trim().toLowerCase()).filter(Boolean)
}

/** The startup dialog owning the screen, or null when the screen is anything else. */
export function startupDialogReason(
  emulator: HeadlessEmulator
): RuntimeTerminalWaitBlockedReason | null {
  return dialogReason(normalizedLines(emulator.getVisibleLines()))
}

function dialogReason(lines: string[]): RuntimeTerminalWaitBlockedReason | null {
  if (!TRUST_DIALOG_FOOTER_RE.test(lines.at(-1) ?? '')) {
    return null
  }
  // The live footer is the last line, so the whole grid can be read; a tall dialog's heading sits above the tail window.
  const reason = findTerminalWaitBlockedSignal(lines.join('\n'), { wholeText: true })?.reason
  if (reason && TRUST_REASONS.has(reason)) {
    const choices = lines.slice(-TRUST_DIALOG_CHOICE_ROWS, -1)
    return choices.some((line) => TRUST_DIALOG_CHOICE_RE.test(line)) ? reason : null
  }
  return reason && STARTUP_MENU_REASONS.has(reason) ? reason : null
}

/** The last block of non-blank rows above the key footer, where Claude's Ink select paints its choices. */
function inkChoiceBlock(rows: string[]): { start: number; end: number } {
  let end = rows.length - 1
  while (end >= 0 && !rows[end].trim()) {
    end -= 1
  }
  // Skip the footer and the blank rows above it.
  end -= 1
  while (end >= 0 && !rows[end].trim()) {
    end -= 1
  }
  let start = end
  while (start > 0 && rows[start - 1].trim()) {
    start -= 1
  }
  return { start, end }
}

/** The choice rows aimed from the highlighted row; [] when they do not read as the heading's verified menu. */
function inkMenuChoices(choiceRows: string[], heading: string): NativeChatStartupMenuChoice[] {
  // The dialog's own heading, not leftover text above it, sets how many rows are choices.
  const expected = CLAUDE_MENU_CHOICE_COUNTS.find(([re]) => re.test(heading.toLowerCase()))?.[1]
  const matches = choiceRows.map((row) => INK_CHOICE_ROW_RE.exec(row))
  const cursor = matches.findIndex((match) => match?.[1] === '\u276f')
  if (
    matches.length !== expected ||
    cursor === -1 ||
    matches.some((match, index) => !match || (match[1] === '\u276f') !== (index === cursor))
  ) {
    return []
  }
  return matches.map((match, index) => ({ label: match![2], send: menuKeys(cursor, index) }))
}

/** Arrow keys from the highlighted row to the target row, then Return. */
function menuKeys(cursor: number, target: number): string {
  const arrow = target > cursor ? '\x1b[B' : '\x1b[A'
  return `${arrow.repeat(Math.abs(target - cursor))}\r`
}

/** Claude's server multi-select: its submit row enables the ticked servers, and Esc (the footer's action) rejects all. */
function inkMultiSelectMenu(
  choiceRows: string[],
  heading: string
): { servers: string[]; choices: NativeChatStartupMenuChoice[] } | null {
  const count = Number(CLAUDE_MCP_SERVERS_HEADING_RE.exec(heading.toLowerCase())?.[1])
  const servers = choiceRows.slice(0, -1).map((row) => INK_CHECKBOX_ROW_RE.exec(row))
  const submit = INK_SUBMIT_ROW_RE.exec(choiceRows.at(-1) ?? '')
  // A wrapped server name adds a row that reads as neither, so the menu is not aimable.
  if (servers.length !== count || !submit || servers.some((match) => !match)) {
    return null
  }
  const cursors = [...servers.map((match) => match![1]), submit[1]]
  const cursor = cursors.indexOf('\u276f')
  if (cursor === -1 || cursors.lastIndexOf('\u276f') !== cursor) {
    return null
  }
  return {
    servers: servers.map((match) => `[${match![2]}] ${match![3]}`),
    choices: [
      { label: submit[2], send: menuKeys(cursor, servers.length) },
      { label: 'Reject all', send: ESCAPE }
    ]
  }
}

/** Rows joined into paragraphs: wrapped rows rejoin with a space, blank rows separate paragraphs. */
function paragraphs(rows: string[]): string[] {
  const out: string[] = []
  let current: string[] = []
  for (const row of [...rows, '']) {
    const text = row.trim()
    if (text) {
      current.push(text)
    } else if (current.length > 0) {
      out.push(current.join(' '))
      current = []
    }
  }
  return out
}

/** Claude's dialog under its rule: the heading picks the menu, and the warning text is shown before any choice. */
function inkMenu(
  rows: string[]
): { heading: string; description: string; choiceRows: string[] } | null {
  const rule = rows.findLastIndex((row) => DIALOG_RULE_RE.test(row.trim()))
  if (rule === -1) {
    return null
  }
  const block = inkChoiceBlock(rows)
  if (block.start <= rule) {
    return null
  }
  const text = paragraphs(rows.slice(rule + 1, block.start))
  if (text.length === 0) {
    return null
  }
  return {
    heading: text[0],
    description: text.join('\n\n'),
    choiceRows: rows.slice(block.start, block.end + 1)
  }
}

/** The card for the dialog on screen and whether its answers are aimed; null when no dialog owns the screen. */
export function startupDialogPrompt(
  emulator: HeadlessEmulator,
  agent: TuiAgent
): { prompt: string; aimed: boolean } | null {
  const rows = emulator.getVisibleLines()
  const lines = normalizedLines(rows)
  const reason = dialogReason(lines)
  if (!reason) {
    return null
  }
  if (TRUST_REASONS.has(reason)) {
    const keys = trustChoiceKeys(lines)
    return { prompt: buildNativeChatFolderTrustPrompt(keys), aimed: keys !== null }
  }
  // Only Claude's menu keys are verified (2.1.316); other agents' menus get a card without answers.
  if (agent !== 'claude' || reason !== 'agent-startup-menu-prompt') {
    return { prompt: buildNativeChatStartupMenuPrompt({ choices: [] }), aimed: true }
  }
  const menu = inkMenu(rows)
  const multiSelect = menu ? inkMultiSelectMenu(menu.choiceRows, menu.heading) : null
  // The ticked rows are what "Enable selected" enables, so the card shows them with its warning.
  const description = multiSelect
    ? `${menu!.description}\n\n${multiSelect.servers.join('\n')}`
    : menu?.description
  // A clipped list hides ticks the card would approve, so only the terminal can answer it.
  const choices = multiSelect
    ? description!.length <= STARTUP_MENU_DESCRIPTION_MAX
      ? multiSelect.choices
      : []
    : menu
      ? inkMenuChoices(menu.choiceRows, menu.heading)
      : []
  return {
    prompt: buildNativeChatStartupMenuPrompt({
      ...(description ? { description } : {}),
      choices
    }),
    aimed: choices.length > 0
  }
}

/** Arrow keys from the highlighted choice to the trust choice, then Return; null when the layout is not the known two-choice one. */
function trustChoiceKeys(lines: string[]): string | null {
  const choices = lines.slice(-TRUST_DIALOG_CHOICE_ROWS, -1)
  const cursor = choices.findIndex((line) => TRUST_DIALOG_CURSOR_RE.test(line))
  const trust = choices.findIndex((line) => TRUST_DIALOG_CHOICE_RE.test(line))
  // Rows between the two choices may be wrapped text, not choices, so only adjacent rows are trusted.
  if (cursor === -1 || trust === -1 || Math.abs(trust - cursor) > 1) {
    return null
  }
  return menuKeys(cursor, trust)
}
