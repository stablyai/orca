import type {
  AdoptedRootProcess,
  RuntimePtyWorktreeRecord
} from '../../terminal/records/runtime-terminal-state-records'
import { OrcaRuntimeWithListManagedWorktrees } from '../managed-workspace-operations'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  describeLaunchedAgentHost,
  readAdoptedRootAgentForeground,
  readExactAgentForeground,
  readLaunchedAgentForeground,
  type LaunchedAgentForeground,
  type LaunchedAgentHost
} from '../../terminal/wait/launched-agent-foreground'
import { reattachedRestTitleAgent } from '../../terminal/wait/reattached-rest-title'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'

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
    // Why first: a host that can't find an agent in front (Windows, WSL) can never confirm one.
    if (!this.launchedAgentHostProvesAgent(ptyId)) {
      return false
    }
    const pty = this.ptysById.get(ptyId)
    const outputClockAt = this.readOutputClockAt(ptyId)
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const foreground = await this.readRestTitleForeground(pty, ptyId, agent)
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

  private async readRestTitleForeground(
    pty: RuntimePtyWorktreeRecord | undefined,
    ptyId: string,
    agent: TuiAgent
  ): Promise<LaunchedAgentForeground> {
    if (!pty || pty.connectionId || this.ptyController?.supportsForegroundObservation?.(ptyId)) {
      return readExactAgentForeground(this, this.ptyController, ptyId, agent)
    }
    // Why the root on an old local owner: its launched-agent read lists every session per pane.
    let root = pty.adoptedRootProcess
    if (!root || root.incarnationId !== pty.incarnationId) {
      // Attach can come before discovery stores it; the owner joins a sweep's lookups into one listing.
      root = await this.findAdoptedRoot(ptyId)
      if (!root || this.ptysById.get(ptyId) !== pty || root.incarnationId !== pty.incarnationId) {
        return 'unknown'
      }
      pty.adoptedRootProcess = root
    }
    return readAdoptedRootAgentForeground(this.ptyController, root.pid, ptyId, agent)
  }

  private async findAdoptedRoot(ptyId: string): Promise<AdoptedRootProcess | null> {
    try {
      const listed = await this.ptyController?.listProcesses?.(LOCAL_EXECUTION_HOST_ID, {
        ptyIds: [ptyId],
        targetOwnerOnly: true
      })
      const row = listed?.find((pane) => pane.id === ptyId)
      return row?.rootProcessId
        ? { incarnationId: row.incarnationId ?? null, pid: row.rootProcessId }
        : null
    } catch {
      return null
    }
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
