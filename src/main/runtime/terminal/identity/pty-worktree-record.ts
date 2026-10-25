import { RuntimeWorkspaceRepoScanRefresh } from '../../workspaces/workspace-repo-scan-refresh'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { cloneAgentSessionOwnerBinding } from '../../../../shared/claimed-agent-pty-owner-snapshot'
import { advertisedUrlWatcher } from '../../../ports/advertised-url-watcher'
import { maxTimestamp } from '../../runtime-worktree-status-projection'
import type { RuntimeSyncedLeaf } from '../../../../shared/runtime-types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import { inferWorktreeIdFromPtyId } from '../../runtime-worktree-path-identity'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  mainDecidesLeafLiveness,
  mainPaneRecordFacts,
  noteMainPaneRecordChange,
  withoutPaneClaim
} from '../surface/main-terminal-surfaces'
import {
  recordPtySurfaceClaim,
  SURFACE_CLAIM_WITHOUT_STANDING
} from '../../pty-recorded-surface-topology'

export abstract class OrcaRuntimeWithRecordPtyWorktree extends RuntimeWorkspaceRepoScanRefresh {
  /** Switch-on, a pane main owns is no proof its terminal runs: its record decides (L80). */
  protected mainDecidesLiveness(worktreeId: string): boolean {
    return mainDecidesLeafLiveness(this, worktreeId)
  }

  /** An inventory's connection verdict; main's panes that bind the terminal re-compose. */
  protected setPtyConnected(pty: RuntimePtyWorktreeRecord, connected: boolean): void {
    const prior = mainPaneRecordFacts(pty)
    pty.connected = connected
    pty.disconnectedAt = connected ? null : (pty.disconnectedAt ?? Date.now())
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      noteMainPaneRecordChange(this, prior, pty)
    }
  }

  protected abstract nextTitleObservationSequence(): number

  protected abstract setPtyManagementTitleFromObservedTitle(
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ): void

  protected abstract invalidatePtyIncarnationHandle(ptyId: string): void

  /** Date changed inventory titles once so reconciliation cannot masquerade as new shell evidence. */
  protected recordPtyWorktree(
    ptyId: string,
    worktreeId: string,
    state: Partial<
      Pick<
        RuntimePtyWorktreeRecord,
        | 'connected'
        | 'lastOutputAt'
        | 'preview'
        | 'tabId'
        | 'paneKey'
        | 'surfaceRecordedAtGraphSequence'
        | 'title'
        | 'connectionId'
        | 'runtimeSessionOwned'
        | 'isWsl'
        | 'wslDistro'
        | 'incarnationId'
        | 'agentSessionOwners'
      >
    > = {}
  ): RuntimePtyWorktreeRecord {
    // Switch point: main's layout is the one answer to a terminal's pane, so no claim is copied.
    const prior = ORCA_LAYOUT_OWNER_IS_MAIN ? mainPaneRecordFacts(this.ptysById.get(ptyId)) : null
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      state = withoutPaneClaim(state)
    }
    let pty = this.ptysById.get(ptyId)
    if (!pty) {
      const titleObservedAt = state.title ? this.nextTitleObservationSequence() : null
      const connectionId = state.connectionId ?? parseAppSshPtyId(ptyId)?.connectionId ?? null
      const worktreePath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
      const fallbackWslDistro =
        process.platform === 'win32' && connectionId === null && worktreePath
          ? parseWslUncPath(worktreePath)?.distro
          : undefined
      const wslDistro =
        connectionId === null
          ? (state.wslDistro ?? this.wslDistroByPtyId.get(ptyId) ?? fallbackWslDistro ?? null)
          : null
      pty = {
        ptyId,
        incarnationId: state.incarnationId ?? null,
        worktreeId,
        connectionId,
        runtimeSessionOwned: state.runtimeSessionOwned ?? false,
        isWsl: state.isWsl ?? null,
        wslDistro,
        ...(ORCA_LAYOUT_OWNER_IS_MAIN
          ? {}
          : {
              tabId: state.tabId ?? null,
              paneKey: state.paneKey ?? null,
              // Graph silence cannot contradict a never-observed claim, especially headless; the next statement decides.
              surfaceRecordedAtGraphSequence: Math.max(
                this.graphSequence,
                state.surfaceRecordedAtGraphSequence ?? this.graphSequence
              )
            }),
        launchConfig: null,
        launchToken: null,
        launchIncarnationId: null,
        launchAgent: null,
        launchCommandAgent: null,
        agentSessionOwners: (state.agentSessionOwners ?? []).map(cloneAgentSessionOwnerBinding),
        foregroundAgent: null,
        connected: state.connected ?? true,
        disconnectedAt: state.connected === false ? Date.now() : null,
        lastExitCode: null,
        lastExitCause: null,
        lastAgentStatus: null,
        lastAgentStatusObservedLive: false,
        lastAgentStatusStartedAtEpochMs: null,
        lastAgentStatusRichInvalidatedAtEpochMs: null,
        lastOscTitle: null,
        lastOscTitleAt: null,
        lastOscTitleEpochMs: null,
        managementTitle: null,
        managementTitleAt: null,
        controllerTitle: null,
        title: state.title ?? null,
        titleUpdatedAt: titleObservedAt,
        titleObservedAtEpochMs: titleObservedAt !== null ? Date.now() : null,
        lastOutputAt: state.lastOutputAt ?? null,
        tailBuffer: [],
        tailTranscriptBuffer: [],
        tailTranscriptChars: 0,
        tailPartialLine: '',
        tailPendingAnsi: '',
        tailRedrawCursor: null,
        tailTruncated: false,
        tailLinesTotal: 0,
        preview: state.preview ?? '',
        waitBlockedAt: null
      }
      if (state.title) {
        this.setPtyManagementTitleFromObservedTitle(pty, state.title, titleObservedAt ?? 0)
      }
      this.ptysById.set(ptyId, pty)
      if (wslDistro) {
        this.wslDistroByPtyId.set(ptyId, wslDistro)
      } else if (connectionId !== null) {
        // Restored SSH ids can collide with local parser state; establish connection ownership before parsing bytes.
        this.wslDistroByPtyId.delete(ptyId)
      }
      // Restored/discovered PTYs bypass registerPty, so bind URL enrichment here.
      advertisedUrlWatcher.bindPty(ptyId, worktreeId)
      if (prior !== null) {
        noteMainPaneRecordChange(this, prior, pty)
      }
      return pty
    }

    pty.worktreeId = worktreeId
    if (
      state.incarnationId !== undefined &&
      pty.incarnationId !== null &&
      state.incarnationId !== pty.incarnationId
    ) {
      pty.agentSessionOwners = []
    }
    // A reused id's new process must not settle exit waits with the old process's code.
    if (
      ORCA_LAYOUT_OWNER_IS_MAIN &&
      state.incarnationId &&
      state.incarnationId !== pty.incarnationId
    ) {
      pty.lastExitCode = null
      pty.lastExitCause = null
    }
    if (state.incarnationId !== undefined) {
      if (pty.incarnationId && state.incarnationId && pty.incarnationId !== state.incarnationId) {
        this.invalidatePtyIncarnationHandle(ptyId)
        this.retirePredecessorPtyExitEvidence(pty)
      }
      pty.incarnationId = state.incarnationId
    }
    if (state.agentSessionOwners !== undefined) {
      pty.agentSessionOwners = state.agentSessionOwners.map(cloneAgentSessionOwnerBinding)
    }
    if (state.connectionId !== undefined) {
      pty.connectionId = state.connectionId
      if (state.connectionId !== null) {
        pty.wslDistro = null
        this.wslDistroByPtyId.delete(ptyId)
      }
    }
    if (state.runtimeSessionOwned !== undefined) {
      pty.runtimeSessionOwned = state.runtimeSessionOwned
    }
    if (state.isWsl !== undefined) {
      pty.isWsl = state.isWsl
    }
    if (state.wslDistro !== undefined) {
      pty.wslDistro = state.wslDistro
      if (state.wslDistro) {
        this.wslDistroByPtyId.set(ptyId, state.wslDistro)
      } else {
        this.wslDistroByPtyId.delete(ptyId)
      }
    }
    if (state.tabId !== undefined) {
      pty.tabId = state.tabId
    }
    if (state.paneKey !== undefined) {
      // Persisted replay cannot gain graph standing and resurrect a dropped pane (#18191).
      recordPtySurfaceClaim(
        pty,
        state.paneKey,
        state.surfaceRecordedAtGraphSequence ?? SURFACE_CLAIM_WITHOUT_STANDING
      )
    }
    if (state.connected !== undefined) {
      pty.connected = state.connected
      pty.disconnectedAt = state.connected ? null : (pty.disconnectedAt ?? Date.now())
    }
    if (state.lastOutputAt !== undefined) {
      pty.lastOutputAt = maxTimestamp(pty.lastOutputAt, state.lastOutputAt)
    }
    if (state.preview !== undefined && state.preview.length > 0) {
      pty.preview = state.preview
    }
    if (
      state.title !== undefined &&
      state.title !== null &&
      state.title.length > 0 &&
      state.title !== pty.title
    ) {
      const observedAt = this.nextTitleObservationSequence()
      pty.title = state.title
      pty.titleUpdatedAt = observedAt
      pty.titleObservedAtEpochMs = Date.now()
      this.setPtyManagementTitleFromObservedTitle(pty, state.title, observedAt)
    }
    // Bind URL enrichment at the common worktree-resolution point, including restore and controller discovery.
    advertisedUrlWatcher.bindPty(ptyId, worktreeId)
    if (prior !== null) {
      noteMainPaneRecordChange(this, prior, pty)
    }
    return pty
  }

  protected makeRuntimePaneKey(
    leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>
  ): string {
    return isTerminalLeafId(leaf.leafId)
      ? makePaneKey(leaf.tabId, leaf.leafId)
      : `${leaf.tabId}:${leaf.paneRuntimeId}`
  }

  protected getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null {
    const existing = this.ptysById.get(ptyId)
    if (existing) {
      return existing
    }
    const inferredWorktreeId = inferWorktreeIdFromPtyId(ptyId)
    if (!inferredWorktreeId) {
      return null
    }
    // Worktree-prefixed daemon ids preserve mobile summaries across graph gaps/reloads.
    return this.recordPtyWorktree(ptyId, inferredWorktreeId)
  }
}
