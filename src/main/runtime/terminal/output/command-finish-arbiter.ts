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

type Lane = keyof CommandMarkLanes

export type CommandFinishArbiterDeps = {
  /** The pane's agent when its host can find one in front; null applies a mark at once. */
  agentFor(ptyId: string): TuiAgent | null
  /** Undefined once the pane's terminal is gone. */
  incarnationOf(ptyId: string): string | null | undefined
  /** `agent` only when the program in front is that agent itself. */
  readForeground(ptyId: string, agent: TuiAgent): Promise<LaunchedAgentForeground>
  /** The shell finished the command. */
  finish(ptyId: string, lanes: CommandMarkLanes): void
  /** The agent printed the mark itself and still runs, or the pane runs another process now. */
  dismiss(ptyId: string, lanes: CommandMarkLanes): void
}

type PendingMark = {
  lanes: CommandMarkLanes
  incarnation: string | null | undefined
  /** Which of its lane's marks this is: the other lane's mark with the same count is the same one. */
  count: number
  read: Promise<LaunchedAgentForeground>
}

type PaneMarks = { counts: Record<Lane, number>; pending: Partial<Record<Lane, PendingMark>> }

/** One owner for an OSC 133;D. Agents such as Devin print their own around each turn, so in a pane
 *  with an agent a mark counts only once a read finds the shell, not that agent, in front.
 *  An unknown read, or a command starting before it answers, keeps the mark, as before. Each lane
 *  reads bytes at its own pace (the title tracker trails command paint), so each settles only its
 *  own marks; the two share a read only for the same mark. */
export class CommandFinishArbiter {
  private readonly panes = new Map<string, PaneMarks>()

  constructor(private readonly deps: CommandFinishArbiterDeps) {}

  note(ptyId: string, lanes: CommandMarkLanes): void {
    const lane: Lane = lanes.authority ? 'authority' : 'paint'
    const agent = this.deps.agentFor(ptyId)
    let pane = this.panes.get(ptyId)
    if (!pane && !agent) {
      this.deps.finish(ptyId, lanes)
      return
    }
    pane ??= { counts: { authority: 0, paint: 0 }, pending: {} }
    this.panes.set(ptyId, pane)
    pane.counts[lane] += 1
    // A newer mark in this lane decides; the earlier one's read no longer speaks for it.
    delete pane.pending[lane]
    if (!agent) {
      this.deps.finish(ptyId, lanes)
      return
    }
    const count = pane.counts[lane]
    const incarnation = this.deps.incarnationOf(ptyId)
    const other = pane.pending[lane === 'authority' ? 'paint' : 'authority']
    const read =
      other && other.count === count && other.incarnation === incarnation
        ? other.read
        : this.deps.readForeground(ptyId, agent).catch(() => 'unknown' as const)
    const mark: PendingMark = { lanes, incarnation, count, read }
    pane.pending[lane] = mark
    void this.decide(ptyId, lane, mark)
  }

  /** A command started after `lane` saw its pending mark: the mark was the shell's. */
  noteCommandStarted(ptyId: string, lane: Lane): void {
    const mark = this.panes.get(ptyId)?.pending[lane]
    if (mark) {
      this.settle(ptyId, lane, mark, 'shell')
    }
  }

  private async decide(ptyId: string, lane: Lane, mark: PendingMark): Promise<void> {
    const foreground = await mark.read
    if (this.panes.get(ptyId)?.pending[lane] === mark) {
      this.settle(ptyId, lane, mark, foreground)
    }
  }

  private settle(
    ptyId: string,
    lane: Lane,
    mark: PendingMark,
    foreground: LaunchedAgentForeground
  ): void {
    const pane = this.panes.get(ptyId)
    delete pane?.pending[lane]
    const incarnation = this.deps.incarnationOf(ptyId)
    if (incarnation === undefined && !pane?.pending.authority && !pane?.pending.paint) {
      this.panes.delete(ptyId)
    }
    // Why: a rebind reset what the old process owned; its mark must not retire the new one's.
    if (foreground === 'agent' || incarnation !== mark.incarnation) {
      this.deps.dismiss(ptyId, mark.lanes)
    } else {
      this.deps.finish(ptyId, mark.lanes)
    }
  }
}
