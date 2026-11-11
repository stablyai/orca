import {
  buildNativeChatFolderTrustPrompt,
  buildNativeChatStartupMenuPrompt,
  type NativeChatStartupMenuChoice
} from '../../../../shared/native-chat/input/native-chat-approval-envelope'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/runtime-terminal-contracts'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { findTerminalWaitBlockedSignal } from '../../agent-state-rules/blocked-text-layer'

// A live dialog ends on its key footer; quoted dialog text in a reply does not.
const TRUST_DIALOG_FOOTER_RE =
  /^(?:enter to confirm \u00b7 esc to cancel|enter(?:\/esc)? (?:continue|confirm) \u00b7 (?:esc (?:quit|skip)|ctrl\+c quit))$/
const TRUST_REASONS: ReadonlySet<RuntimeTerminalWaitBlockedReason> = new Set([
  'agent-trust-workspace',
  'codex-trust-workspace'
])
// Only dialogs that precede a first prompt; mid-session approvals have their own cards.
const STARTUP_MENU_REASONS: ReadonlySet<RuntimeTerminalWaitBlockedReason> = new Set([
  'agent-update-prompt',
  'agent-cwd-prompt',
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
  const reason = findTerminalWaitBlockedSignal(lines.join('\n'))?.reason
  if (reason && TRUST_REASONS.has(reason)) {
    const choices = lines.slice(-TRUST_DIALOG_CHOICE_ROWS, -1)
    return choices.some((line) => TRUST_DIALOG_CHOICE_RE.test(line)) ? reason : null
  }
  return reason && STARTUP_MENU_REASONS.has(reason) ? reason : null
}

/** The rows of the Ink select just above the key footer, aimed from the highlighted row; [] when they do not read as one. */
function inkMenuChoices(rows: string[], heading: string): NativeChatStartupMenuChoice[] {
  // The dialog's own heading, not leftover text above it, sets how many rows are choices.
  const expected = CLAUDE_MENU_CHOICE_COUNTS.find(([re]) => re.test(heading.toLowerCase()))?.[1]
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
  const matches = rows.slice(start, end + 1).map((row) => INK_CHOICE_ROW_RE.exec(row))
  const cursor = matches.findIndex((match) => match?.[1] === '\u276f')
  if (
    matches.length !== expected ||
    cursor === -1 ||
    matches.some((match, index) => !match || (match[1] === '\u276f') !== (index === cursor))
  ) {
    return []
  }
  return matches.map((match, index) => {
    const arrow = index > cursor ? '\x1b[B' : '\x1b[A'
    return { label: match![2], send: `${arrow.repeat(Math.abs(index - cursor))}\r` }
  })
}

/** The heading under Claude's dialog rule, unwrapped, shown on the card so its choices read in context. */
function inkMenuHeading(rows: string[]): string | undefined {
  const rule = rows.findLastIndex((row) => DIALOG_RULE_RE.test(row.trim()))
  if (rule === -1) {
    return undefined
  }
  const end = rows.findIndex((row, index) => index > rule && !row.trim())
  const heading = rows.slice(rule + 1, end === -1 ? undefined : end)
  return heading.map((row) => row.trim()).join(' ') || undefined
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
  const description = inkMenuHeading(rows)
  const choices = inkMenuChoices(rows, description ?? '')
  return {
    prompt: buildNativeChatStartupMenuPrompt({ ...(description ? { description } : {}), choices }),
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
  const arrow = trust > cursor ? '\x1b[B' : '\x1b[A'
  return `${arrow.repeat(Math.abs(trust - cursor))}\r`
}
