import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import { findTerminalWaitBlockedSignal } from './agent-state-rules/blocked-text-layer'
import type { LaunchedAgentForeground } from './launched-agent-foreground'

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

function isTrustDialogOnScreen(emulator: HeadlessEmulator): boolean {
  const lines = emulator
    .getVisibleLines()
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
  if (
    !TRUST_DIALOG_FOOTER_RE.test(lines.at(-1) ?? '') ||
    !lines.slice(-TRUST_DIALOG_CHOICE_ROWS, -1).some((line) => TRUST_DIALOG_CHOICE_RE.test(line))
  ) {
    return false
  }
  const reason = findTerminalWaitBlockedSignal(lines.join('\n'))?.reason
  return reason === 'agent-trust-workspace' || reason === 'codex-trust-workspace'
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
      this.publishWaiting(ptyId, pane, agent)
      return
    }
    // An agent typed into a shell paints its dialog before the foreground-process probe names it.
    pane.resolvingAgent = true
    const resolved = () => {
      pane.resolvingAgent = false
      const current = this.deps.getEmulator(ptyId)
      if (this.panes.get(ptyId) === pane && current && isTrustDialogOnScreen(current)) {
        this.publishWaiting(ptyId, pane, this.deps.getPaneAgent(ptyId))
      }
    }
    void this.deps.refreshForegroundAgent(ptyId).then(resolved, resolved)
  }

  forget(ptyId: string): void {
    clearTimeout(this.panes.get(ptyId)?.readTimer)
    this.panes.delete(ptyId)
  }

  private publishWaiting(ptyId: string, pane: PaneScan, agent: TuiAgent | null): void {
    // Only Claude's and Codex's dialogs are verified to precede their hooks and repaint without flicker.
    if (agent !== 'claude' && agent !== 'codex') {
      return
    }
    const before = this.deps.readStatus(ptyId)
    if (before?.observation?.origin === 'hook' && !before.providerSessionOnly) {
      return
    }
    this.deps.publish(ptyId, { state: 'waiting', agentType: agent, prompt: '' })
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
    const owned = pane.owned
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
