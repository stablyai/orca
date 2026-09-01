// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithGetTerminalInteractiveWait } from './orca-runtime-get-terminal-interactive-wait'
import type {
  RuntimeTerminalRead,
  RuntimeTerminalResolvePane,
  RuntimeTerminalShow
} from '../../shared/runtime-types'
import type { RuntimeProviderSnapshotReadOptions } from './runtime-terminal-contracts'
import { parsePaneKey } from '../../shared/stable-pane-id'
import {
  buildVisibleSnapshotReadFallback,
  labelTerminalReadSource,
  readTerminalTail
} from './terminal-tail-read'
import { getTerminalState } from './terminal-wait-results'

export class OrcaRuntimeWithResolveTerminalPane extends OrcaRuntimeWithGetTerminalInteractiveWait {
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
      this.getPaneKeyForTerminalHandle(expectedHandle) !== paneKey
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
    if (
      !this.getRecentExpiredSshLease(expectedWorktreeId, parsed.tabId, parsed.leafId, pty.ptyId)
    ) {
      // Why: an explicit close leaves a terminated lease; only relay expiry authorizes shell recreation.
      throw new Error('terminal_not_recoverable')
    }
    // Why: disconnected PTYs can reissue handles during graph cleanup; only a connected replacement satisfies the pane CAS.
    const recovery = this.createTerminal(`id:${expectedWorktreeId}`, {
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      focus: false
    }).then((terminal) => ({
      handle: terminal.handle,
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      ptyId: terminal.ptyId ?? null,
      worktreeId: expectedWorktreeId
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
      return {
        ...summary,
        preview,
        tabId: pty.pty.tabId ?? pty.record.tabId,
        leafId: parsePaneKey(pty.pty.paneKey ?? '')?.leafId ?? pty.record.leafId,
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
    const projection = visibleState ?? (await this.readProviderTerminalTailLines(ptyId, opts.limit))
    if (projection.lines.length === 0) {
      return { ...read, source: 'screen-unavailable' }
    }
    return buildVisibleSnapshotReadFallback(read, projection.lines, opts.limit, projection.draft)
  }
}
