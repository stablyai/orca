import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import {
  buildNativeChatFolderTrustPrompt,
  buildNativeChatStartupMenuPrompt,
  type NativeChatStartupMenuChoice
} from '../../shared/native-chat-approval-envelope'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import { findTerminalWaitBlockedSignal } from './agent-state-rules/blocked-text-layer'
import type { LaunchedAgentForeground } from './launched-agent-foreground'

// Cell-diff painters (Claude's Ink) replace spaces with cursor moves, so match one key-row word, not the phrase.
const TRUST_KEYWORD_RE = /trust|confirm|continue|skip/i
const TRUST_KEYWORD_CARRY_CHARS = 'continue'.length - 1
const TRUST_DIALOG_PAINT_BYTES = 4096
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
const INK_CHOICES_MAX = 9
const DIALOG_RULE_RE = /^\u2500+$/
const TRUST_DIALOG_CHOICE_RE =
  /^(?:[\u276f\u203a]\s*)?(?:\d+\.\s*)?(?:yes, i trust this folder|trust and continue)$/
const TRUST_DIALOG_CHOICE_ROWS = 6
const TRUST_DIALOG_CURSOR_RE = /^[\u276f\u203a]/
/** Screen reads while our row is up are throttled to this; a working agent's output cannot hold the row. */
const TRUST_DIALOG_READ_INTERVAL_MS = 400
// Claude repaints without sync markers, so a resize clear read before its redraw is not proof the dialog left.
const TRUST_DIALOG_CLEAR_AFTER_MISSES = 2

type PaneScan = {
  carry: string
  /** Output still allowed to finish painting a dialog whose keyword was seen. */
  pendingBytes: number
  resolvingAgent?: boolean
  /** The waiting row we published, identified by its receipt stamp like hook-silence rechecks. */
  owned?: { agent: 'claude' | 'codex'; receivedAt: number }
  /** The card we published; republished when the terminal moves the cursor. */
  prompt?: string
  misses: number
  outputSinceRead?: boolean
  readTimer?: ReturnType<typeof setTimeout>
}

type TrustDialogStatusDeps = {
  getPaneAgent: (ptyId: string) => TuiAgent | null
  refreshForegroundAgent: (ptyId: string) => Promise<unknown>
  readLaunchedAgentForeground: (ptyId: string, agent: TuiAgent) => Promise<LaunchedAgentForeground>
  /** The PTY's current screen model; replaced on renderer-snapshot recovery, undefined once gone. */
  getEmulator: (ptyId: string) => HeadlessEmulator | undefined
  readStatus: (ptyId: string) => AgentStatusIpcPayload | undefined
  /** A sidebar projection of the blocked text agentWait already reads, never first-party agent evidence. */
  publish: (ptyId: string, payload: ParsedAgentStatusPayload) => void
}

function visibleLines(emulator: HeadlessEmulator): string[] {
  return emulator
    .getVisibleLines()
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
}

/** The startup dialog owning the screen, or null when the screen is anything else. */
function startupDialogReason(emulator: HeadlessEmulator): RuntimeTerminalWaitBlockedReason | null {
  const lines = visibleLines(emulator)
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
function inkMenuChoices(rows: string[]): NativeChatStartupMenuChoice[] {
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
    matches.length < 2 ||
    matches.length > INK_CHOICES_MAX ||
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

/** The heading under Claude's dialog rule, shown on the card so its choices read in context. */
function inkMenuHeading(rows: string[]): string | undefined {
  const rule = rows.findLastIndex((row) => DIALOG_RULE_RE.test(row.trim()))
  return rule === -1 ? undefined : rows[rule + 1]?.trim() || undefined
}

/** The card for the dialog on screen and whether its answers are aimed; null when no dialog owns the screen. */
function startupDialogPrompt(
  emulator: HeadlessEmulator,
  agent: TuiAgent
): { prompt: string; aimed: boolean } | null {
  const reason = startupDialogReason(emulator)
  if (!reason) {
    return null
  }
  if (TRUST_REASONS.has(reason)) {
    const keys = trustChoiceKeys(emulator)
    return { prompt: buildNativeChatFolderTrustPrompt(keys), aimed: keys !== null }
  }
  // Only Claude's menu keys are verified (2.1.316); other agents' menus get a card without answers.
  if (agent !== 'claude' || reason !== 'agent-startup-menu-prompt') {
    return { prompt: buildNativeChatStartupMenuPrompt({ choices: [] }), aimed: true }
  }
  const rows = emulator.getVisibleLines()
  const choices = inkMenuChoices(rows)
  const description = inkMenuHeading(rows)
  return {
    prompt: buildNativeChatStartupMenuPrompt({ ...(description ? { description } : {}), choices }),
    aimed: choices.length > 0
  }
}

/** Arrow keys from the highlighted choice to the trust choice, then Return; null when the layout is not the known two-choice one. */
function trustChoiceKeys(emulator: HeadlessEmulator): string | null {
  const choices = visibleLines(emulator).slice(-TRUST_DIALOG_CHOICE_ROWS, -1)
  const cursor = choices.findIndex((line) => TRUST_DIALOG_CURSOR_RE.test(line))
  const trust = choices.findIndex((line) => TRUST_DIALOG_CHOICE_RE.test(line))
  // Rows between the two choices may be wrapped text, not choices, so only adjacent rows are trusted.
  if (cursor === -1 || trust === -1 || Math.abs(trust - cursor) > 1) {
    return null
  }
  const arrow = trust > cursor ? '\x1b[B' : '\x1b[A'
  return `${arrow.repeat(Math.abs(trust - cursor))}\r`
}

/** Projects a Claude/Codex startup dialog (folder trust, MCP servers, updates…) into the pane's status row; hooks only start after it. */
export class TrustDialogStatusObserver {
  private readonly panes = new Map<string, PaneScan>()

  constructor(private readonly deps: TrustDialogStatusDeps) {}

  observe(ptyId: string, emulator: HeadlessEmulator, chunk: string): void {
    let pane = this.panes.get(ptyId)
    if (!pane) {
      pane = { carry: '', pendingBytes: 0, misses: 0 }
      this.panes.set(ptyId, pane)
    }
    if (pane.owned) {
      // A hook or any other writer that replaced our row owns the pane from here.
      if (!this.ownsRow(ptyId, pane.owned)) {
        this.forget(ptyId)
        return
      }
      pane.outputSinceRead = true
      this.scheduleRead(ptyId, pane)
      return
    }
    // The carry catches the keyword split across PTY reads without copying the chunk.
    const seam = pane.carry + chunk.slice(0, TRUST_KEYWORD_CARRY_CHARS)
    if (TRUST_KEYWORD_RE.test(chunk) || TRUST_KEYWORD_RE.test(seam)) {
      pane.pendingBytes = TRUST_DIALOG_PAINT_BYTES
    }
    pane.carry = (pane.carry + chunk.slice(-TRUST_KEYWORD_CARRY_CHARS)).slice(
      -TRUST_KEYWORD_CARRY_CHARS
    )
    if (pane.pendingBytes <= 0 || pane.resolvingAgent || emulator.isSynchronizedOutput) {
      return
    }
    if (!startupDialogReason(emulator)) {
      pane.pendingBytes -= chunk.length
      return
    }
    pane.pendingBytes = 0
    const agent = this.deps.getPaneAgent(ptyId)
    if (agent) {
      this.publishWaiting(ptyId, pane, agent, emulator)
      return
    }
    // An agent typed into a shell paints its dialog before the foreground-process probe names it.
    pane.resolvingAgent = true
    const resolved = () => {
      pane.resolvingAgent = false
      const current = this.deps.getEmulator(ptyId)
      if (this.panes.get(ptyId) === pane && current && startupDialogReason(current)) {
        this.publishWaiting(ptyId, pane, this.deps.getPaneAgent(ptyId), current)
      }
    }
    void this.deps.refreshForegroundAgent(ptyId).then(resolved, resolved)
  }

  forget(ptyId: string): void {
    clearTimeout(this.panes.get(ptyId)?.readTimer)
    this.panes.delete(ptyId)
  }

  private publishWaiting(
    ptyId: string,
    pane: PaneScan,
    agent: TuiAgent | null,
    emulator: HeadlessEmulator
  ): void {
    // Only Claude's and Codex's dialogs are verified to precede their hooks and repaint without flicker.
    if (agent !== 'claude' && agent !== 'codex') {
      return
    }
    const before = this.deps.readStatus(ptyId)
    if (before?.observation?.origin === 'hook' && !before.providerSessionOnly) {
      return
    }
    // Chat views answer or lock on this card; without it a sent message's Return picks the highlighted choice.
    const card = startupDialogPrompt(emulator, agent)
    if (!card) {
      return
    }
    pane.prompt = card.prompt
    this.deps.publish(ptyId, {
      state: 'waiting',
      agentType: agent,
      prompt: '',
      interactivePrompt: card.prompt
    })
    const row = this.deps.readStatus(ptyId)
    if (row?.state === 'waiting' && row.agentType === agent) {
      pane.owned = { agent, receivedAt: row.receivedAt }
    }
  }

  private ownsRow(ptyId: string, owned: NonNullable<PaneScan['owned']>): boolean {
    const row = this.deps.readStatus(ptyId)
    return row?.state === 'waiting' && row.receivedAt === owned.receivedAt
  }

  private scheduleRead(ptyId: string, pane: PaneScan): void {
    if (pane.readTimer !== undefined) {
      return
    }
    pane.readTimer = setTimeout(() => {
      void this.read(ptyId, pane)
        .catch(() => false)
        .then((again) => {
          pane.readTimer = undefined
          if (again && this.panes.get(ptyId) === pane) {
            this.scheduleRead(ptyId, pane)
          }
        })
    }, TRUST_DIALOG_READ_INTERVAL_MS)
    pane.readTimer.unref?.()
  }

  /** Returns whether another read is due. */
  private async read(ptyId: string, pane: PaneScan): Promise<boolean> {
    let owned = pane.owned
    const emulator = this.deps.getEmulator(ptyId)
    if (this.panes.get(ptyId) !== pane || !owned) {
      return false
    }
    if (!emulator || !this.ownsRow(ptyId, owned)) {
      this.forget(ptyId)
      return false
    }
    pane.outputSinceRead = false
    if (emulator.isSynchronizedOutput) {
      return true
    }
    const card = startupDialogPrompt(emulator, owned.agent)
    if (!card) {
      pane.misses += 1
      if (pane.misses < TRUST_DIALOG_CLEAR_AFTER_MISSES) {
        return true
      }
      this.settle(ptyId, owned)
      return false
    }
    pane.misses = 0
    // A mid-repaint read cannot aim, so only an aimed card replaces the one up.
    if (card.aimed && card.prompt !== pane.prompt) {
      this.publishWaiting(ptyId, pane, owned.agent, emulator)
      owned = pane.owned ?? owned
    }
    // A killed agent can leave its frame above the shell prompt; only a proven shell foreground settles it.
    const foreground = await this.deps.readLaunchedAgentForeground(ptyId, owned.agent)
    if (this.panes.get(ptyId) !== pane) {
      return false
    }
    if (foreground === 'shell') {
      this.settle(ptyId, owned)
      return false
    }
    return pane.outputSinceRead
  }

  private settle(ptyId: string, owned: NonNullable<PaneScan['owned']>): void {
    this.forget(ptyId)
    if (this.ownsRow(ptyId, owned)) {
      // A session boundary, not a finished turn: no notification or unread badge.
      this.deps.publish(ptyId, {
        state: 'done',
        agentType: owned.agent,
        prompt: '',
        sessionBoundary: true
      })
    }
  }
}
