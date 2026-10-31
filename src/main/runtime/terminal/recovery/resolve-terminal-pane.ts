import {
  captureTerminalSurfaceCloseIdentity,
  captureAddressedTerminalPresentation
} from '../../workspace-session-terminal-tab-retirement-identity'
import { terminalLaunchFacts } from '../../../../shared/agent-session-resume'
import type { OrcaRuntimeWithCreateTerminal } from '../launch/terminal-create'
import type * as Read from '../../../../shared/runtime-types'
import type { RuntimeTerminalResolvePane } from '../../../../shared/runtime-types'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-contracts'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { OrcaRuntimeWithReadTerminalPane } from './terminal-pane-read'

export abstract class OrcaRuntimeWithResolveTerminalPane extends OrcaRuntimeWithReadTerminalPane {
  abstract createTerminal(
    ...args: Parameters<OrcaRuntimeWithCreateTerminal['createTerminal']>
  ): ReturnType<OrcaRuntimeWithCreateTerminal['createTerminal']>

  abstract getTerminalHandleForPaneKey(paneKey: string): string | null
  abstract getPtyExecutionHostMetadata(
    ptyId: string | null
  ): Pick<RuntimeTerminalCreate, 'executionHostId' | 'hostPlatform' | 'incarnationId'>
  protected abstract getPaneKeyForTerminalHandle(handle: string): string | null
  protected abstract getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>>
  protected abstract buildPtyTerminalSummary(
    pty: RuntimePtyWorktreeRecord,
    worktreesById: Map<string, ResolvedWorktree>
  ): Read.RuntimeTerminalSummary

  protected abstract buildTerminalSummary(
    leaf: RuntimeLeafRecord,
    worktreesById: Map<string, ResolvedWorktree>,
    provenLivePtyIds?: ReadonlySet<string> | null
  ): Read.RuntimeTerminalSummary

  resolveTerminalPane(paneKey: string, expectedWorktreeId?: string): RuntimeTerminalResolvePane {
    // Why: the renderer context menu only knows the stable pane key; main owns
    // the runtime terminal handle that agents and CLI commands can address.
    const handle = this.getTerminalHandleForPaneKey(paneKey)
    if (!handle) {
      throw new Error('terminal_not_found')
    }
    const record = this.handles.get(handle)
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed ? this.leaves.get(this.getLeafKey(parsed.tabId, parsed.leafId)) : null
    const pty = this.getPtyRecordForPaneKey(paneKey)
    const candidateWorktreeIds = [leaf?.worktreeId, pty?.worktreeId].filter(
      (worktreeId): worktreeId is string => Boolean(worktreeId)
    )
    const worktreeId = candidateWorktreeIds[0] ?? null
    if (
      (candidateWorktreeIds.length > 1 && new Set(candidateWorktreeIds).size > 1) ||
      (expectedWorktreeId && candidateWorktreeIds.some((id) => id !== expectedWorktreeId)) ||
      (expectedWorktreeId && candidateWorktreeIds.length === 0)
    ) {
      // Why: pane coordinates restored by a paired client must not cross workspace ownership.
      throw new Error('terminal_not_found')
    }
    const holders =
      worktreeId && parsed
        ? this.getWorkspaceSessionHostIdsForTab(worktreeId, parsed.tabId).map((hostId) => ({
            hostId,
            identity: captureTerminalSurfaceCloseIdentity(
              this.store?.getWorkspaceSession?.(hostId),
              worktreeId,
              parsed.tabId,
              parsed.leafId
            )
          }))
        : []
    const rowIdentity = holders[0]?.identity
    const executionPtyId = pty?.ptyId ?? record?.ptyId ?? leaf?.ptyId ?? null
    const retained = executionPtyId ? this.handleByPtyIncarnation.get(executionPtyId) : null
    const execution = this.getPtyExecutionHostMetadata(executionPtyId)
    if (
      !execution.incarnationId &&
      retained?.handle === handle &&
      executionPtyId &&
      this.getPtyLivenessVerdict(executionPtyId)?.status === 'exited'
    ) {
      execution.incarnationId = retained.incarnationId ?? undefined
    }
    const identity =
      parsed && worktreeId
        ? captureAddressedTerminalPresentation({
            runtimeId: this.runtimeId,
            record,
            currentPty: pty,
            paneOfPty: (current) => this.paneOfPty(current),
            leaf,
            row: rowIdentity,
            address: { worktreeId, ...parsed },
            ptyId: executionPtyId,
            incarnationId: execution.incarnationId
          })
        : null
    return {
      ...(identity ? { presentation: { identity, holders } } : {}),
      handle,
      tabId: parsed?.tabId ?? record?.tabId ?? '',
      leafId: parsed?.leafId ?? record?.leafId ?? '',
      ptyId: executionPtyId,
      connected: pty?.connected === true,
      ...(worktreeId ? { worktreeId } : {}),
      ...execution
    }
  }

  /** Actual placement of an exact live child; a launch claim's original coordinates can be stale. */
  resolveLiveTerminalSurface(ptyId: string, incarnationId: string | undefined) {
    const pty = this.ptysById.get(ptyId)
    if (!pty?.connected || !incarnationId || pty.incarnationId !== incarnationId) {
      return null
    }
    const pane = this.paneOfPty(pty)
    const parsed = pane.paneKey ? parsePaneKey(pane.paneKey) : null
    if (!parsed) {
      return null
    }
    return { ...parsed, worktreeId: pty.worktreeId, terminalHandle: this.issuePtyHandle(pty) }
  }

  /** Whether the caller's handle still names the pane it asks to recover. */
  private handleNamesRecoveredPane(
    handle: string,
    paneKey: string,
    worktreeId: string,
    pty: RuntimePtyWorktreeRecord
  ): boolean {
    const handlePaneKey = this.getPaneKeyForTerminalHandle(handle)
    if (handlePaneKey === paneKey) {
      return true
    }
    if (!ORCA_LAYOUT_OWNER_IS_MAIN || handlePaneKey !== null) {
      return false
    }
    // A pane-resolved handle may learn its connected replacement only after its own terminal ended; never spawn here.
    const staleRecord = this.handles.get(handle)
    const stale = staleRecord?.ptyId ? this.ptysById.get(staleRecord.ptyId) : undefined
    return (
      staleRecord?.issuedForPaneKey === paneKey &&
      !stale?.connected &&
      pty.connected &&
      this.getTerminalWorktreeIdForHandle(handle) === worktreeId
    )
  }

  async recoverTerminalPane(
    paneKey: string,
    expectedWorktreeId: string,
    expectedHandle?: string
  ): Promise<RuntimeTerminalResolvePane> {
    const parsed = parsePaneKey(paneKey)
    const pty = this.getPtyRecordForPaneKey(paneKey)
    if (
      !parsed ||
      !pty ||
      !expectedHandle ||
      pty.worktreeId !== expectedWorktreeId ||
      !this.handleNamesRecoveredPane(expectedHandle, paneKey, expectedWorktreeId, pty)
    ) {
      throw new Error('terminal_not_found')
    }
    const recoveryKey = `${expectedWorktreeId}\0${paneKey}`
    const pending = this.terminalPaneRecoveryByIdentity.get(recoveryKey)
    if (pending) {
      return pending
    }
    if (pty?.connected) {
      const current = this.resolveTerminalPane(paneKey, expectedWorktreeId)
      if (expectedHandle === undefined || current.handle !== expectedHandle) {
        return current
      }
      throw new Error('terminal_not_recoverable')
    }
    const expiredLease = this.getRecentExpiredSshLease(
      expectedWorktreeId,
      parsed.tabId,
      parsed.leafId,
      pty.ptyId
    )
    if (!expiredLease) {
      // Only an unsuperseded expired relay lease permits recreation; terminated/recycled/superseded ids must not adopt another process.
      throw new Error('terminal_not_recoverable')
    }
    // Expired leases and disconnected records prove only lost routing; live/unverifiable verdicts refuse duplicate spawns.
    // Do not require exited: host-certified exits terminate leases, while reachable not-found can follow relay restart (docs/reference/ssh-execution-boundary.md).
    const liveness = this.getPtyLivenessVerdict(pty.ptyId)
    if (liveness?.status === 'unverifiable' || liveness?.status === 'live') {
      throw new Error('terminal_not_recoverable')
    }
    // Why: disconnected PTYs can reissue handles during graph cleanup; only a connected replacement satisfies the pane CAS.
    const recovery = this.createTerminal(`id:${expectedWorktreeId}`, {
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      focus: false
    }).then((terminal) => ({
      ...terminalLaunchFacts(terminal),
      handle: terminal.handle,
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      ptyId: terminal.ptyId ?? null,
      worktreeId: expectedWorktreeId,
      ...(terminal.incarnationId ? { incarnationId: terminal.incarnationId } : {})
    }))
    this.terminalPaneRecoveryByIdentity.set(recoveryKey, recovery)
    const clearRecovery = (): void => {
      if (this.terminalPaneRecoveryByIdentity.get(recoveryKey) === recovery) {
        this.terminalPaneRecoveryByIdentity.delete(recoveryKey)
      }
    }
    void recovery.then(clearRecovery, clearRecovery)
    return recovery
  }

  async showTerminal(handle: string): Promise<Read.RuntimeTerminalShow> {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      const worktreesById = await this.getResolvedWorktreeMap()
      const summary = this.buildPtyTerminalSummary(pty.pty, worktreesById)
      const preview = await this.visibleSnapshotPreview(pty.pty.ptyId, summary.preview)
      this.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
      const agentWait = await this.getTerminalInteractiveWait(handle)
      const recorded = this.paneOfPty(pty.pty)
      return {
        ...summary,
        preview,
        tabId: recorded.tabId ?? pty.record.tabId,
        leafId: parsePaneKey(recorded.paneKey ?? '')?.leafId ?? pty.record.leafId,
        paneRuntimeId: -1,
        ptyId: pty.pty.ptyId,
        rendererGraphEpoch: this.rendererGraphEpoch,
        ...(agentWait !== undefined ? { agentWait } : {})
      }
    }
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktreesById = await this.getResolvedWorktreeMap()
    this.assertStableReadyGraph(graphEpoch)
    const { leaf } = this.getLiveLeafForHandle(handle)
    const summary = this.buildTerminalSummary(leaf, worktreesById)
    const preview = leaf.ptyId
      ? await this.visibleSnapshotPreview(leaf.ptyId, summary.preview)
      : summary.preview
    this.assertStableReadyGraph(graphEpoch)
    if (leaf.ptyId) {
      this.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId)
    }
    const agentWait = await this.getTerminalInteractiveWait(handle)
    return {
      ...summary,
      preview,
      paneRuntimeId: leaf.paneRuntimeId,
      ptyId: leaf.ptyId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      ...(agentWait !== undefined ? { agentWait } : {})
    }
  }
}
