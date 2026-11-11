import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { buildNativeChatFolderTrustPrompt } from '../../../../shared/native-chat/input/native-chat-approval-envelope'
import type { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { findTerminalWaitBlockedSignal } from '../../agent-state-rules/blocked-text-layer'
import type { LaunchedAgentForeground } from '../wait/launched-agent-foreground'

// Cell-diff painters (Claude's Ink) replace spaces with cursor moves, so match one word, not the phrase.
const TRUST_KEYWORD_RE = /trust/i
const TRUST_KEYWORD_CARRY_CHARS = 'trust'.length - 1
const TRUST_DIALOG_PAINT_BYTES = 4096
// A live dialog ends on its key footer with the trust choice just above; quoted dialog text in a reply does not.
const TRUST_DIALOG_FOOTER_RE =
  /^(?:enter to confirm \u00b7 esc to cancel|enter continue \u00b7 esc quit)$/
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
  /** Receipt stamp of the agentless card that locks Send while the agent is identified. */
  holdReceivedAt?: number
  /** The waiting row we published, identified by its receipt stamp like hook-silence rechecks. */
  owned?: { agent: 'claude' | 'codex'; receivedAt: number }
  /** Keys our card sends; republished when the terminal moves the cursor. */
  trustKeys?: string | null
  misses: number
  outputSinceRead?: boolean
  readTimer?: ReturnType<typeof setTimeout>
}

type TrustDialogStatusDeps = {
  getPaneAgent: (ptyId: string) => TuiAgent | null
  /** Names a hand-typed agent for this dialog only; null when launch/foreground evidence already owns the pane. */
  identifyUnownedAgent: (ptyId: string) => Promise<TerminalAgent | null | undefined> | null
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

function isTrustDialogOnScreen(emulator: HeadlessEmulator): boolean {
  const lines = visibleLines(emulator)
  if (
    !TRUST_DIALOG_FOOTER_RE.test(lines.at(-1) ?? '') ||
    !lines.slice(-TRUST_DIALOG_CHOICE_ROWS, -1).some((line) => TRUST_DIALOG_CHOICE_RE.test(line))
  ) {
    return false
  }
  const reason = findTerminalWaitBlockedSignal(lines.join('\n'))?.reason
  return reason === 'agent-trust-workspace' || reason === 'codex-trust-workspace'
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

/** Projects a Claude/Codex folder-trust dialog into the pane's status row; hooks only start after trust. */
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
    if (!isTrustDialogOnScreen(emulator)) {
      pane.pendingBytes -= chunk.length
      return
    }
    pane.pendingBytes = 0
    const agent = this.deps.getPaneAgent(ptyId)
    if (agent) {
      this.publishWaiting(ptyId, pane, agent, emulator)
      return
    }
    this.hold(ptyId, pane, emulator)
    this.identifyAndPublish(ptyId, pane)
  }

  // An agent typed into a shell paints its dialog before the foreground-process probe names it.
  private identifyAndPublish(ptyId: string, pane: PaneScan): void {
    pane.resolvingAgent = true
    const resolved = (identified?: TerminalAgent | null) => {
      pane.resolvingAgent = false
      const current = this.deps.getEmulator(ptyId)
      if (this.panes.get(ptyId) !== pane || !current || !isTrustDialogOnScreen(current)) {
        this.release(ptyId, pane)
        return
      }
      const agent = identified ?? this.deps.getPaneAgent(ptyId)
      // A timed-out probe answers undefined; a static dialog repaints nothing to rescan on, so retry
      // until it leaves. A later probe reads the shared scan's cached answer.
      if (identified === undefined && !agent) {
        pane.resolvingAgent = true
        setTimeout(
          () => this.identifyAndPublish(ptyId, pane),
          TRUST_DIALOG_READ_INTERVAL_MS
        ).unref?.()
        return
      }
      this.publishWaiting(ptyId, pane, agent, current)
      if (!pane.owned) {
        this.release(ptyId, pane)
      }
      pane.holdReceivedAt = undefined
    }
    void Promise.resolve(this.deps.identifyUnownedAgent(ptyId)).then(resolved, () => resolved())
  }

  private hold(ptyId: string, pane: PaneScan, emulator: HeadlessEmulator): void {
    const before = this.deps.readStatus(ptyId)
    if (before?.observation?.origin === 'hook' && !before.providerSessionOnly) {
      return
    }
    this.deps.publish(ptyId, {
      state: 'waiting',
      prompt: '',
      interactivePrompt: buildNativeChatFolderTrustPrompt(trustChoiceKeys(emulator))
    })
    pane.holdReceivedAt = this.deps.readStatus(ptyId)?.receivedAt
  }

  /** Clears the agentless hold unless a writer replaced it; only Claude and Codex keep a card. */
  private release(ptyId: string, pane: PaneScan): void {
    const receivedAt = pane.holdReceivedAt
    pane.holdReceivedAt = undefined
    const row = this.deps.readStatus(ptyId)
    if (receivedAt !== undefined && row?.state === 'waiting' && row.receivedAt === receivedAt) {
      this.deps.publish(ptyId, { state: 'done', prompt: '', sessionBoundary: true })
    }
  }

  forget(ptyId: string): void {
    clearTimeout(this.panes.get(ptyId)?.readTimer)
    this.panes.delete(ptyId)
  }

  private publishWaiting(
    ptyId: string,
    pane: PaneScan,
    agent: TerminalAgent | null,
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
    // Chat views answer this card; without it a sent message's Return picks the highlighted "No, exit".
    const keys = trustChoiceKeys(emulator)
    pane.trustKeys = keys
    this.deps.publish(ptyId, {
      state: 'waiting',
      agentType: agent,
      prompt: '',
      interactivePrompt: buildNativeChatFolderTrustPrompt(keys)
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
    if (!isTrustDialogOnScreen(emulator)) {
      pane.misses += 1
      if (pane.misses < TRUST_DIALOG_CLEAR_AFTER_MISSES) {
        return true
      }
      this.settle(ptyId, owned)
      return false
    }
    pane.misses = 0
    const keys = trustChoiceKeys(emulator)
    if (keys !== pane.trustKeys) {
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
