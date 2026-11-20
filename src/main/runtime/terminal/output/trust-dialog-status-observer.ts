import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import type { LaunchedAgentForeground } from '../wait/launched-agent-foreground'
import { startupDialogPrompt, startupDialogReason } from './startup-dialog-screen'

// Cell-diff painters (Claude's Ink) replace spaces with cursor moves, so match one key-row word, not the phrase.
const TRUST_KEYWORD_RE = /trust|confirm|continue|skip|reject/i
const TRUST_KEYWORD_CARRY_CHARS = 'continue'.length - 1
const TRUST_DIALOG_PAINT_BYTES = 4096
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
  /** An unaimable card seen once; it replaces ours only if the next read still shows it. */
  unaimedPrompt?: string
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

/** Projects a Claude/Codex startup dialog (folder trust, MCP servers, updates…) into the pane's status row; hooks only start after it. */
export class TrustDialogStatusObserver {
  private readonly panes = new Map<string, PaneScan>()
  /** The received-output sequence each pane's last card choice was written at. */
  private readonly choiceAt = new Map<string, number>()

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

  /**
   * Claims a card choice while the dialog on screen still reads as `prompt` (its keys are aimed from that
   * screen's highlight). One choice per screen: a second client's keys would land on whatever the first opens.
   */
  claimChoice(ptyId: string, prompt: string, outputSequence: number): boolean {
    if (this.choiceAt.get(ptyId) === outputSequence) {
      return false
    }
    // A card restored after an Orca restart has no owner here until new output arrives.
    const agent = this.panes.get(ptyId)?.owned?.agent ?? this.deps.getPaneAgent(ptyId)
    const emulator = this.deps.getEmulator(ptyId)
    if (
      !agent ||
      !emulator ||
      emulator.isSynchronizedOutput ||
      startupDialogPrompt(emulator, agent)?.prompt !== prompt
    ) {
      return false
    }
    this.choiceAt.set(ptyId, outputSequence)
    return true
  }

  forget(ptyId: string): void {
    clearTimeout(this.panes.get(ptyId)?.readTimer)
    this.panes.delete(ptyId)
    this.choiceAt.delete(ptyId)
  }

  private publishWaiting(
    ptyId: string,
    pane: PaneScan,
    agent: TuiAgent | null,
    emulator: HeadlessEmulator,
    read?: { prompt: string }
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
    const card = read ?? startupDialogPrompt(emulator, agent)
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
    // A mid-repaint read cannot aim; a stale aimed card would send old arrows, so a steady unaimed one replaces it.
    const awaitingSteadyRead =
      card.prompt !== pane.prompt && !card.aimed && pane.unaimedPrompt !== card.prompt
    pane.unaimedPrompt = awaitingSteadyRead ? card.prompt : undefined
    if (card.prompt !== pane.prompt && !awaitingSteadyRead) {
      this.publishWaiting(ptyId, pane, owned.agent, emulator, card)
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
    return pane.outputSinceRead || awaitingSteadyRead
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
