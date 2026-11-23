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

export type CommandFinishArbiterDeps = {
  /** The pane's agent when its host can find one in front; null applies a mark at once. */
  agentFor(ptyId: string): TuiAgent | null
  readForeground(ptyId: string, agent: TuiAgent): Promise<LaunchedAgentForeground>
  /** The shell finished the command: retire what the command owned. */
  finish(ptyId: string, exitCode: number | null): void
  /** The agent printed the mark itself and still runs. */
  dismiss(ptyId: string): void
}

/** One owner for an OSC 133;D: agents such as Devin print their own around each turn, so in a pane
 *  with an agent the mark is the shell's only once the foreground read finds the shell in front.
 *  An unknown read keeps the mark, as before; the latest mark decides. */
export class CommandFinishArbiter {
  private readonly pending = new Map<string, number>()
  private nextMark = 0

  constructor(private readonly deps: CommandFinishArbiterDeps) {}

  note(ptyId: string, exitCode: number | null): void {
    const agent = this.deps.agentFor(ptyId)
    if (!agent) {
      this.pending.delete(ptyId)
      this.deps.finish(ptyId, exitCode)
      return
    }
    const mark = ++this.nextMark
    this.pending.set(ptyId, mark)
    void this.decide(ptyId, agent, exitCode, mark)
  }

  private async decide(
    ptyId: string,
    agent: TuiAgent,
    exitCode: number | null,
    mark: number
  ): Promise<void> {
    const foreground = await this.deps.readForeground(ptyId, agent).catch(() => 'unknown' as const)
    if (this.pending.get(ptyId) !== mark) {
      return
    }
    this.pending.delete(ptyId)
    if (foreground === 'agent') {
      this.deps.dismiss(ptyId)
    } else {
      this.deps.finish(ptyId, exitCode)
    }
  }
}
