import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { AgentStatusState } from '../../../shared/agent-status/contracts/agent-status-types'

export type ZotzLiveAgentPane = {
  paneKey: string
  agent: TuiAgent
  /** Hook-reported state: working, or waiting on the user (blocked/waiting/done). */
  state: AgentStatusState
  worktreeId: string | null
}

/** One agent terminal: its whole process tree now and the highest seen this run. */
export type ZotzAgentMemoryUsage = ZotzLiveAgentPane & {
  bytes: number
  peakBytes: number
  startedAt: number
}

/** A run whose terminal went away since the last sample. */
export type ZotzFinishedAgentRun = Pick<
  ZotzAgentMemoryUsage,
  'paneKey' | 'agent' | 'worktreeId' | 'peakBytes' | 'startedAt'
> & { endedAt: number }

export type ZotzAgentMemorySample = {
  agents: ZotzAgentMemoryUsage[]
  finished: ZotzFinishedAgentRun[]
}

type ZotzAgentMemorySamplerDeps = {
  listAgentPanes: () => ZotzLiveAgentPane[]
  /** Memory of each local terminal's process tree, by pane. */
  measurePanes: () => Promise<Map<string, number>>
  now: () => number
}

/**
 * Follows agent terminals between samples so each run's peak reaches the ledger when it ends
 * (docs/zotz/PLAN.md §8b). A pane that never got a measurement is not recorded.
 */
export class ZotzAgentMemorySampler {
  private readonly tracked = new Map<string, ZotzAgentMemoryUsage>()

  constructor(private readonly deps: ZotzAgentMemorySamplerDeps) {}

  hasLiveAgents(): boolean {
    return this.deps.listAgentPanes().length > 0
  }

  async sample(): Promise<ZotzAgentMemorySample> {
    const panes = this.deps.listAgentPanes()
    const measured = panes.length > 0 ? await this.deps.measurePanes() : new Map<string, number>()
    const live = new Set<string>()
    const finished: ZotzAgentMemorySample['finished'] = []
    for (const pane of panes) {
      live.add(pane.paneKey)
      const bytes = measured.get(pane.paneKey) ?? 0
      const previous = this.tracked.get(pane.paneKey)
      // A pane reused by a different agent is a new run; the old one ends here.
      const sameRun = previous !== undefined && previous.agent === pane.agent
      if (previous && !sameRun && previous.peakBytes > 0) {
        finished.push(this.finish(previous))
      }
      this.tracked.set(pane.paneKey, {
        ...pane,
        bytes,
        peakBytes: Math.max(bytes, sameRun ? previous.peakBytes : 0),
        startedAt: sameRun ? previous.startedAt : this.deps.now()
      })
    }
    for (const [paneKey, usage] of this.tracked) {
      if (!live.has(paneKey)) {
        this.tracked.delete(paneKey)
        if (usage.peakBytes > 0) {
          finished.push(this.finish(usage))
        }
      }
    }
    return { agents: [...this.tracked.values()], finished }
  }

  private finish(usage: ZotzAgentMemoryUsage): ZotzFinishedAgentRun {
    const { paneKey, agent, worktreeId, peakBytes, startedAt } = usage
    return { paneKey, agent, worktreeId, peakBytes, startedAt, endedAt: this.deps.now() }
  }
}
