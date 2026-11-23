import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import type { LaunchedAgentForeground } from '../wait/launched-agent-foreground'

/** The agent a pane runs, launched or recognized in front: the program whose own marks are not the shell's. */
export function commandMarkAgent(record: {
  launchAgent?: TuiAgent | null
  launchCommandAgent?: TuiAgent | null
  foregroundAgent?: TerminalAgent | null
}): TuiAgent | null {
  const agent = record.launchAgent ?? record.launchCommandAgent ?? record.foregroundAgent ?? null
  return isTuiAgent(agent) ? agent : null
}

/** Who reads a mark: the runtime's launch and hook authority (`exitCode`), and command paint. */
export type CommandMarkLanes = { authority?: { exitCode: number | null }; paint?: true }

export type CommandFinishArbiterDeps = {
  /** The pane's agent when its host can find one in front; null applies a mark at once. */
  agentFor(ptyId: string): TuiAgent | null
  incarnationOf(ptyId: string): string | null | undefined
  /** `agent` only when the program in front is that agent itself. */
  readForeground(ptyId: string, agent: TuiAgent): Promise<LaunchedAgentForeground>
  /** The shell finished the command. */
  finish(ptyId: string, lanes: CommandMarkLanes): void
  /** The agent printed the mark itself and still runs, or the pane runs another process now. */
  dismiss(ptyId: string, lanes: CommandMarkLanes): void
}

type PendingMark = {
  agent: TuiAgent
  incarnation: string | null | undefined
  lanes: CommandMarkLanes
}

/** One owner for an OSC 133;D. Agents such as Devin print their own around each turn, so in a pane
 *  with an agent a mark counts only once one read finds the shell, not that agent, in front.
 *  An unknown read, or a command starting before it answers, keeps the mark, as before. */
export class CommandFinishArbiter {
  private readonly pending = new Map<string, PendingMark>()

  constructor(private readonly deps: CommandFinishArbiterDeps) {}

  /** A lane saw a mark. The other lane's sight of the same mark joins its read; a second mark in
   *  one lane is a newer mark, whose read decides both. */
  note(ptyId: string, lane: CommandMarkLanes): void {
    const earlier = this.takeCurrent(ptyId)
    const agent = this.deps.agentFor(ptyId)
    if (!agent) {
      this.deps.finish(ptyId, { ...earlier?.lanes, ...lane })
      return
    }
    const joins =
      earlier &&
      !(lane.authority && earlier.lanes.authority) &&
      !(lane.paint && earlier.lanes.paint)
    if (earlier && joins) {
      earlier.lanes = { ...earlier.lanes, ...lane }
      this.pending.set(ptyId, earlier)
      return
    }
    const mark: PendingMark = {
      agent,
      incarnation: this.deps.incarnationOf(ptyId),
      lanes: { ...earlier?.lanes, ...lane }
    }
    this.pending.set(ptyId, mark)
    void this.decide(ptyId, mark)
  }

  /** A command started after `lane` saw the pending mark: it was the shell's, finishing the last
   *  command. Lanes read bytes at their own pace, so only a start the same lane saw after the mark
   *  is later in byte order. */
  noteCommandStarted(ptyId: string, lane: keyof CommandMarkLanes): void {
    if (!this.pending.get(ptyId)?.lanes[lane]) {
      return
    }
    const mark = this.takeCurrent(ptyId)
    if (mark) {
      this.deps.finish(ptyId, mark.lanes)
    }
  }

  /** The pending mark, taken; one an earlier process left is dismissed, never applied to this one. */
  private takeCurrent(ptyId: string): PendingMark | undefined {
    const mark = this.pending.get(ptyId)
    this.pending.delete(ptyId)
    if (mark && this.deps.incarnationOf(ptyId) !== mark.incarnation) {
      this.deps.dismiss(ptyId, mark.lanes)
      return undefined
    }
    return mark
  }

  private async decide(ptyId: string, mark: PendingMark): Promise<void> {
    const foreground = await this.deps
      .readForeground(ptyId, mark.agent)
      .catch(() => 'unknown' as const)
    if (this.pending.get(ptyId) !== mark) {
      return
    }
    this.pending.delete(ptyId)
    // Why: a rebind reset what the old process owned; its mark must not retire the new one's.
    if (foreground === 'agent' || this.deps.incarnationOf(ptyId) !== mark.incarnation) {
      this.deps.dismiss(ptyId, mark.lanes)
    } else {
      this.deps.finish(ptyId, mark.lanes)
    }
  }
}
