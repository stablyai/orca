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
}

/** One owner for an OSC 133;D. Agents such as Devin print their own around each turn, so in a pane
 *  with an agent a mark counts only once a read finds the shell, not that agent, in front.
 *  An unknown read, or a command starting before it answers, keeps the mark, as before. Each lane
 *  reads bytes at its own pace (the title tracker trails command paint) and may see a chunk's marks
 *  differently, so each reads and settles only its own. */
export class CommandFinishArbiter {
  private readonly pending = new Map<string, Partial<Record<Lane, PendingMark>>>()

  constructor(private readonly deps: CommandFinishArbiterDeps) {}

  note(ptyId: string, lanes: CommandMarkLanes): void {
    const lane: Lane = lanes.authority ? 'authority' : 'paint'
    const agent = this.deps.agentFor(ptyId)
    const pane = this.pending.get(ptyId)
    // A newer mark in this lane decides; the earlier one's read no longer speaks for it.
    if (pane) {
      delete pane[lane]
    }
    if (!agent) {
      this.forgetIfIdle(ptyId)
      this.deps.finish(ptyId, lanes)
      return
    }
    const mark: PendingMark = { lanes, incarnation: this.deps.incarnationOf(ptyId) }
    this.pending.set(ptyId, { ...pane, [lane]: mark })
    void this.decide(ptyId, lane, mark, agent)
  }

  /** A command started after `lane` saw its pending mark: the mark was the shell's. */
  noteCommandStarted(ptyId: string, lane: Lane): void {
    const mark = this.pending.get(ptyId)?.[lane]
    if (mark) {
      this.settle(ptyId, lane, mark, 'shell')
    }
  }

  private async decide(
    ptyId: string,
    lane: Lane,
    mark: PendingMark,
    agent: TuiAgent
  ): Promise<void> {
    const foreground = await this.deps.readForeground(ptyId, agent).catch(() => 'unknown' as const)
    if (this.pending.get(ptyId)?.[lane] === mark) {
      this.settle(ptyId, lane, mark, foreground)
    }
  }

  private settle(
    ptyId: string,
    lane: Lane,
    mark: PendingMark,
    foreground: LaunchedAgentForeground
  ): void {
    const pane = this.pending.get(ptyId)
    if (pane) {
      delete pane[lane]
    }
    this.forgetIfIdle(ptyId)
    // Why: a rebind reset what the old process owned; its mark must not retire the new one's.
    if (foreground === 'agent' || this.deps.incarnationOf(ptyId) !== mark.incarnation) {
      this.deps.dismiss(ptyId, mark.lanes)
    } else {
      this.deps.finish(ptyId, mark.lanes)
    }
  }

  private forgetIfIdle(ptyId: string): void {
    const pane = this.pending.get(ptyId)
    if (pane && !pane.authority && !pane.paint) {
      this.pending.delete(ptyId)
    }
  }
}
