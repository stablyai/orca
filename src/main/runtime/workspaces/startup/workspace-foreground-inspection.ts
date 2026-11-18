import { OrcaRuntimeWithListManagedWorktrees } from '../managed-workspace-operations'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  describeLaunchedAgentHost,
  readExactAgentForeground,
  readLaunchedAgentForeground,
  type LaunchedAgentForeground,
  type LaunchedAgentHost
} from '../../terminal/wait/launched-agent-foreground'
import { reattachedRestTitleAgent } from '../../terminal/wait/reattached-rest-title'

export abstract class OrcaRuntimeWithForegroundInspection extends OrcaRuntimeWithListManagedWorktrees {
  launchedAgentTerminalIdentity(ptyId: string): unknown {
    return this.ptysById.get(ptyId)
  }

  /** Read at the physical owner; discard a result that outlived this runtime binding. */
  async readLaunchedAgentForeground(
    ptyId: string,
    agent: TuiAgent
  ): Promise<LaunchedAgentForeground> {
    const pty = this.ptysById.get(ptyId)
    const incarnation = pty?.incarnationId
    const host = this.launchedAgentHost(ptyId)
    const result = await readLaunchedAgentForeground(
      this.ptyController,
      host,
      ptyId,
      agent,
      incarnation ?? undefined
    )
    return this.ptysById.get(ptyId) === pty && pty?.incarnationId === incarnation
      ? result
      : 'unknown'
  }

  /** The rest title's own agent is in front of a pane unchanged since the read began: its idle counts
   *  for the process now running. */
  protected async confirmReattachedRestTitle(ptyId: string, agent: TuiAgent): Promise<boolean> {
    const pty = this.ptysById.get(ptyId)
    const outputClockAt = this.readOutputClockAt(ptyId)
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const foreground = await readExactAgentForeground(this, this.ptyController, ptyId, agent)
    if (
      foreground !== 'agent' ||
      !pty ||
      this.ptysById.get(ptyId) !== pty ||
      this.getPtyLifecycleGeneration(ptyId) !== generation ||
      this.readOutputClockAt(ptyId) !== outputClockAt ||
      reattachedRestTitleAgent(pty) !== agent
    ) {
      return false
    }
    this.applyReattachedAgentStatus(ptyId, 'idle')
    return true
  }

  /** Whether the pane's execution host can find a launched agent in front: a Windows one cannot. */
  launchedAgentHostProvesAgent(ptyId: string): boolean {
    return !this.launchedAgentHost(ptyId).windows
  }

  launchedAgentHostProvesShellAlone(ptyId: string): boolean {
    return this.launchedAgentHost(ptyId).shellAloneProvable
  }

  private launchedAgentHost(ptyId: string): LaunchedAgentHost {
    const pty = this.ptysById.get(ptyId)
    return describeLaunchedAgentHost(pty, () => this.pathFlavorForPty(pty))
  }
}
