import { terminalLaunchFacts } from '../../../../shared/agent-session-resume'
import type { OrcaRuntimeWithCreateTerminal } from '../launch/terminal-create'
import { OrcaRuntimeWithRestoredHandlePaneStart } from '../surface/restored-handle-pane-start'
import type {
  RuntimeTerminalRead,
  RuntimeTerminalResolvePane,
  RuntimeTerminalShow
} from '../../../../shared/runtime-types'
import type {
  RuntimeTerminalCreate,
  RuntimeTerminalSummary
} from '../../../../shared/runtime-terminal-contracts'
import type {
  RuntimeProviderSnapshotReadOptions,
  TerminalHandleRecord
} from '../../runtime-terminal-contracts'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  buildVisibleSnapshotReadFallback,
  labelTerminalReadSource,
  readTerminalTail
} from '../../terminal-tail-read'
import { getTerminalState } from '../../terminal-wait-results'
import { readStructuredWorkerTerminal } from '../../structured-worker-terminal-read'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

export abstract class OrcaRuntimeWithResolveTerminalPane extends OrcaRuntimeWithRestoredHandlePaneStart {
  protected abstract assertLiveTerminalHandleTargetsPty(handle: string, expectedPtyId: string): void
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
  ): RuntimeTerminalSummary
  protected abstract getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  }
  protected abstract buildTerminalSummary(
    leaf: RuntimeLeafRecord,
    worktreesById: Map<string, ResolvedWorktree>,
    provenLivePtyIds?: ReadonlySet<string> | null
  ): RuntimeTerminalSummary
  protected abstract readPtyTerminal(
    handle: string,
    pty: RuntimePtyWorktreeRecord,
    opts?: { cursor?: number; limit?: number }
  ): RuntimeTerminalRead

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
    return {
      handle,
      tabId: parsed?.tabId ?? record?.tabId ?? '',
      leafId: parsed?.leafId ?? record?.leafId ?? '',
      ptyId: record?.ptyId ?? null,
      connected: pty?.connected === true,
      ...(worktreeId ? { worktreeId } : {}),
      ...this.getPtyExecutionHostMetadata(record?.ptyId ?? pty?.ptyId ?? null)
    }
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

  async showTerminal(handle: string): Promise<RuntimeTerminalShow> {
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

  async readTerminal(
    handle: string,
    opts: { cursor?: number; limit?: number; screen?: boolean } = {},
    providerSnapshot: RuntimeProviderSnapshotReadOptions = {}
  ): Promise<RuntimeTerminalRead> {
    // Structured workers have no PTY/leaf; read their journal before PTY lookup can falsely call the handle stale.
    const structured = await readStructuredWorkerTerminal({
      handle,
      db: this.getOrchestrationDbIfAvailable?.() ?? null,
      ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit })
    })
    if (structured) {
      // `screen` asks for a rendered grid; there is none, and the journal is the whole record.
      return { ...structured, source: opts.screen ? 'screen-unavailable' : 'stream' }
    }
    // Switch point: a saved pane main holds with no terminal yet starts first (once, shared).
    const starting = ORCA_LAYOUT_OWNER_IS_MAIN ? this.startRestoredHandlePane(handle) : null
    if (starting) {
      const target = await starting
      return { ...(await this.readTerminal(target, opts, providerSnapshot)), handle }
    }
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      const read = this.readPtyTerminal(handle, pty.pty, opts)
      const visibleRead = opts.screen
        ? await this.readRenderedScreen(pty.pty.ptyId, read, opts)
        : await this.withVisibleSnapshotFallback(pty.pty.ptyId, read, opts, providerSnapshot)
      this.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
      return labelTerminalReadSource(visibleRead)
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    const read = readTerminalTail({
      handle,
      status: getTerminalState(leaf),
      previewLines: leaf.tailBuffer,
      completedLines: leaf.tailTranscriptBuffer,
      partialLine: leaf.tailPartialLine,
      completedLineCount: leaf.tailLinesTotal,
      bufferTruncated: leaf.tailTruncated,
      cursor: opts.cursor,
      limit: opts.limit
    })
    if (!leaf.ptyId) {
      return { ...read, source: opts.screen ? 'screen-unavailable' : 'stream' }
    }
    const visibleRead = opts.screen
      ? await this.readRenderedScreen(leaf.ptyId, read, opts)
      : await this.withVisibleSnapshotFallback(leaf.ptyId, read, opts, providerSnapshot)
    this.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId)
    return labelTerminalReadSource(visibleRead)
  }

  protected async readRenderedScreen(
    ptyId: string,
    read: RuntimeTerminalRead,
    opts: { limit?: number } = {}
  ): Promise<RuntimeTerminalRead> {
    const visibleState = await this.readVisibleTerminalState(ptyId)
    const projection =
      visibleState ??
      (await this.readProviderTerminalTailLines(ptyId, opts.limit, { visibleScreenOnly: true }))
    if (projection.lines.length === 0) {
      return { ...read, source: 'screen-unavailable' }
    }
    return buildVisibleSnapshotReadFallback(
      read,
      projection.lines,
      opts.limit,
      projection.draft,
      projection.tailRows
    )
  }
}
