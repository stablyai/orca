// What a hook-reported terminal agent's turns tell a listener away from the screen: a turn that
// finished (or failed) and an agent that needs input, each with its hook row. The rules and timing
// are the window's; the listener (the phone push, a connector) decides only how to word and send it.
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { agentTurnEndedOnPurpose } from '../../shared/agent-main-agent-verdict'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { AGENT_DONE_QUIET_MS } from '../../shared/agent-transitions'
import { isPiCompatibleAgentType } from '../../shared/pi-agent-kind'

export type TerminalAgentTurnNewsItem = {
  paneKey: string
  worktreeId: string
  row: AgentStatusIpcPayload
}

export type TerminalAgentTurnNewsDeps<Prepared> = {
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  /** Runs when the news is decided, so what it reads is that moment's even if delivery waits. */
  prepare: (news: TerminalAgentTurnNewsItem) => Prepared
  deliver: (prepared: Prepared) => void
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
  /** Opt-in: a turn began (a prompt went in), told at once. */
  started?: (news: TerminalAgentTurnNewsItem) => void
  /** Opt-in: a turn its user stopped or a newer request replaced, which is otherwise no news. */
  stopped?: (news: TerminalAgentTurnNewsItem) => void
}

type PendingFinish = {
  /** Waiting out a finish's quiet window. */
  quiet: { cancel: () => void } | null
}

export class TerminalAgentTurnNews<Prepared> {
  // A pane's pending finish, until it is sent or the pane moves on.
  private readonly pendingByPane = new Map<string, PendingFinish>()
  // Per pane, the `turnCompletedAt` of the turn last announced (or restored), until the next turn.
  private readonly finishedTurnByPane = new Map<string, number>()
  // Panes that reported live work since their last finish: as the window's, only those wait out
  // the quiet window.
  private readonly workingSeen = new Set<string>()

  constructor(private readonly deps: TerminalAgentTurnNewsDeps<Prepared>) {}

  observe(change: AgentPaneChange): void {
    const { paneKey } = change
    if (change.kind === 'seeded') {
      if (change.phase !== 'rest') {
        this.seed(paneKey)
      }
      return
    }
    if (change.kind === 'observed') {
      if (change.phase === 'working') {
        this.observeWorking(paneKey, change.workspace?.worktreeId)
      }
      return
    }
    const { transition } = change
    this.tellOptIn(change)
    const finished = transition === 'turn-finished' || transition === 'errored'
    const row = finished || transition === 'needs-input' ? this.deps.readHookRow(paneKey) : null
    // The all-clear of a turn announced when its lead agent finished: that finish still stands.
    if (
      finished &&
      row?.turnCompletedAt !== undefined &&
      this.finishedTurnByPane.get(paneKey) === row.turnCompletedAt
    ) {
      return
    }
    this.cancelPending(paneKey)
    if (transition === 'prompt-submitted' || change.to === 'rest') {
      this.finishedTurnByPane.delete(paneKey)
    }
    if (change.to === 'rest') {
      this.workingSeen.delete(paneKey)
    }
    if (!row) {
      return
    }
    if (transition === 'needs-input') {
      this.announce(paneKey, change.workspace.worktreeId, row, false)
      return
    }
    // Goal and Pi agents report a milestone done mid-run; work resuming within the window cancels it.
    const waitOutQuiet = this.workingSeen.has(paneKey) || isPiCompatibleAgentType(row.agentType)
    this.workingSeen.delete(paneKey)
    this.announce(paneKey, change.workspace.worktreeId, row, waitOutQuiet)
  }

  dispose(): void {
    for (const paneKey of this.pendingByPane.keys()) {
      this.cancelPending(paneKey)
    }
    this.finishedTurnByPane.clear()
    this.workingSeen.clear()
  }

  private tellOptIn(change: Extract<AgentPaneChange, { kind: 'moved' }>): void {
    const { paneKey, workspace } = change
    if (change.transition === 'prompt-submitted' && this.deps.started) {
      const row = this.deps.readHookRow(paneKey)
      if (row && !row.structuredHost) {
        this.deps.started({ paneKey, worktreeId: workspace.worktreeId, row })
      }
    }
    if (change.to === 'rest' && change.from !== 'rest' && this.deps.stopped) {
      const row = this.deps.readHookRow(paneKey)
      if (row?.state === 'done' && !row.structuredHost && agentTurnEndedOnPurpose(row)) {
        this.deps.stopped({ paneKey, worktreeId: workspace.worktreeId, row })
      }
    }
  }

  private observeWorking(paneKey: string, worktreeId: string | undefined): void {
    const row = this.deps.readHookRow(paneKey)
    if (!row || row.state !== 'working' || !worktreeId) {
      return
    }
    const { turnCompletedAt } = row
    if (turnCompletedAt === undefined) {
      this.workingSeen.add(paneKey)
      return
    }
    // The lead agent finished while background work keeps the pane working: as the window does,
    // that is the turn's finish, named by its `turnCompletedAt` and announced at once, once.
    if (this.finishedTurnByPane.get(paneKey) === turnCompletedAt) {
      return
    }
    this.finishedTurnByPane.set(paneKey, turnCompletedAt)
    // A finish of work this host never saw is the window's to drop too; it still marks the turn told.
    if (!this.workingSeen.has(paneKey)) {
      return
    }
    this.workingSeen.delete(paneKey)
    this.cancelPending(paneKey)
    const finish = { ...row, state: 'done' as const, stateStartedAt: turnCompletedAt }
    this.announce(paneKey, worktreeId, finish, false)
  }

  // As the window seeds a restored pane: a working one counts as work seen, a stamped turn as told.
  private seed(paneKey: string): void {
    const row = this.deps.readHookRow(paneKey)
    if (row?.turnCompletedAt !== undefined) {
      this.finishedTurnByPane.set(paneKey, row.turnCompletedAt)
    }
    if (row?.state === 'working') {
      this.workingSeen.add(paneKey)
    }
  }

  private announce(
    paneKey: string,
    worktreeId: string,
    row: AgentStatusIpcPayload,
    waitOutQuiet: boolean
  ): void {
    // A structured chat's projected row is announced by the structured lane.
    if (row.structuredHost) {
      return
    }
    const prepared = this.deps.prepare({ paneKey, worktreeId, row })
    if (!waitOutQuiet) {
      this.deps.deliver(prepared)
      return
    }
    const pending: PendingFinish = { quiet: null }
    this.pendingByPane.set(paneKey, pending)
    pending.quiet = this.deps.setTimer(() => {
      this.pendingByPane.delete(paneKey)
      this.deps.deliver(prepared)
    }, AGENT_DONE_QUIET_MS)
  }

  private cancelPending(paneKey: string): void {
    this.pendingByPane.get(paneKey)?.quiet?.cancel()
    this.pendingByPane.delete(paneKey)
  }
}
