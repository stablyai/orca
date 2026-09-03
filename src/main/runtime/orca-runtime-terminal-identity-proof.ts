import { OrcaRuntimeWithRemoveManagedWorktree } from './orca-runtime-remove-managed-worktree'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  RuntimeTerminalIdentityProofBegin,
  RuntimeTerminalIdentityProofComplete,
  RuntimeTerminalSummary
} from '../../shared/runtime-types'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import { readTerminalTail } from './terminal-tail-read'
import { MAX_TERMINAL_READ_LIMIT } from './terminal-tail-limits'
import { getPtyTerminalState } from './terminal-wait-results'
import { getLatestLeafTitle, getLatestPtyTitle } from './runtime-worktree-status-projection'
import {
  isSoleLiveTerminalLeafInTab,
  TerminalIdentityProofService
} from './terminal-identity-proof-service'
import type {
  TerminalIdentityProofCandidate,
  TerminalIdentityProofChallenge,
  TerminalIdentityProofDelta
} from './terminal-identity-proof-ledger'

export class OrcaRuntimeWithTerminalIdentityProof extends OrcaRuntimeWithRemoveManagedWorktree {
  // The linear split provides this folder-aware resolver in a successor layer.
  declare protected readonly resolveTerminalWorkspaceLaunchScope: (
    selector: string
  ) => Promise<{ id: string }>

  private readonly terminalIdentityProof = new TerminalIdentityProofService({
    runtimeId: this.runtimeId,
    resolveWorktreeId: async (selector) =>
      (await this.resolveTerminalWorkspaceLaunchScope(selector)).id,
    listTerminals: (worktreeId) =>
      this.listTerminals(`id:${worktreeId}`, 1000, {
        requireFreshPtyLiveness: true,
        includeVisualLayouts: false
      }),
    getWorkspaceExecutionHostId: (worktreeId) =>
      this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId),
    getTopologyRevision: (worktreeId) => this.getTerminalTopologyRevision(worktreeId),
    isCandidateEligible: (_worktreeId, terminal) =>
      terminal.ptyId !== null && (this.leavesByPtyId.get(terminal.ptyId)?.length ?? 0) > 0,
    captureCandidate: (worktreeId, executionHostId, terminal) =>
      this.captureTerminalIdentityProofCandidate(worktreeId, executionHostId, terminal),
    isCandidateCurrent: (worktreeId, candidate) =>
      this.isCurrentTerminalIdentityProofCandidate(worktreeId, candidate),
    readDelta: (candidate) => this.readTerminalIdentityProofDelta(candidate),
    listCurrentNames: (worktreeId, exceptPtyId) =>
      this.listCurrentTerminalIdentityProofNames(worktreeId, exceptPtyId),
    renameCandidate: (challenge, candidate, title) =>
      this.renameTerminalFromIdentityProof(challenge, candidate, title)
  })

  async beginTerminalIdentityProof(
    worktreeSelector: string,
    callerFingerprint?: string
  ): Promise<RuntimeTerminalIdentityProofBegin> {
    return this.terminalIdentityProof.begin(worktreeSelector, callerFingerprint)
  }

  async completeTerminalIdentityProof(
    challengeId: string,
    requestedTitle: string,
    callerFingerprint?: string
  ): Promise<RuntimeTerminalIdentityProofComplete> {
    return this.terminalIdentityProof.complete(challengeId, requestedTitle, callerFingerprint)
  }

  private captureTerminalIdentityProofCandidate(
    worktreeId: string,
    executionHostId: ExecutionHostId,
    terminal: RuntimeTerminalSummary
  ): TerminalIdentityProofCandidate | null {
    if (
      !terminal.ptyId ||
      !terminal.incarnationId ||
      terminal.executionHostId !== executionHostId
    ) {
      return null
    }
    const pty = this.ptysById.get(terminal.ptyId)
    const candidate = {
      handle: terminal.handle,
      ptyId: terminal.ptyId,
      incarnationId: terminal.incarnationId,
      tabId: terminal.tabId,
      leafId: terminal.leafId,
      generation: this.getPtyLifecycleGeneration(terminal.ptyId),
      cursor: pty?.tailLinesTotal ?? -1
    }
    return candidate.cursor >= 0 &&
      this.isCurrentTerminalIdentityProofCandidate(worktreeId, candidate)
      ? candidate
      : null
  }

  private isCurrentTerminalIdentityProofCandidate(
    worktreeId: string,
    candidate: TerminalIdentityProofCandidate
  ): boolean {
    const record = this.handles.get(candidate.handle)
    const pty = this.ptysById.get(candidate.ptyId)
    const leaf = this.leaves.get(makePaneKey(candidate.tabId, candidate.leafId))
    const leaves = this.leavesByPtyId.get(candidate.ptyId) ?? []
    if (
      !record ||
      record.runtimeId !== this.runtimeId ||
      record.rendererGraphEpoch !== this.rendererGraphEpoch ||
      record.ptyId !== candidate.ptyId ||
      record.tabId !== candidate.tabId ||
      record.leafId !== candidate.leafId ||
      !runtimeWorktreeIdsEqual(record.worktreeId, worktreeId) ||
      !isTerminalLeafId(candidate.leafId) ||
      !pty?.connected ||
      pty.incarnationId !== candidate.incarnationId ||
      this.getPtyLifecycleGeneration(candidate.ptyId) !== candidate.generation ||
      !runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId) ||
      pty.tabId !== candidate.tabId ||
      pty.paneKey !== makePaneKey(candidate.tabId, candidate.leafId) ||
      !leaf?.connected ||
      !leaf.writable ||
      leaf.ptyId !== candidate.ptyId ||
      !runtimeWorktreeIdsEqual(leaf.worktreeId, worktreeId) ||
      leaves.length !== 1 ||
      leaves[0] !== leaf ||
      !isSoleLiveTerminalLeafInTab(candidate, this.leaves.values())
    ) {
      return false
    }
    return this.resolveLiveLeafForHandle(candidate.handle)?.ptyId === candidate.ptyId
  }

  private async readTerminalIdentityProofDelta(
    candidate: TerminalIdentityProofCandidate
  ): Promise<TerminalIdentityProofDelta | null> {
    const pty = this.ptysById.get(candidate.ptyId)
    if (
      !pty ||
      pty.incarnationId !== candidate.incarnationId ||
      this.getPtyLifecycleGeneration(candidate.ptyId) !== candidate.generation ||
      candidate.cursor > pty.tailLinesTotal
    ) {
      return null
    }
    const visibleState = await this.readVisibleTerminalState(candidate.ptyId)
    const currentPty = this.ptysById.get(candidate.ptyId)
    if (
      !visibleState ||
      visibleState.generation !== candidate.generation ||
      currentPty !== pty ||
      currentPty.incarnationId !== candidate.incarnationId ||
      this.getPtyLifecycleGeneration(candidate.ptyId) !== candidate.generation
    ) {
      return null
    }
    const stream = readTerminalTail({
      handle: candidate.handle,
      status: getPtyTerminalState(currentPty),
      previewLines: currentPty.tailBuffer,
      completedLines: currentPty.tailTranscriptBuffer,
      partialLine: currentPty.tailPartialLine,
      completedLineCount: currentPty.tailLinesTotal,
      bufferTruncated: currentPty.tailTruncated,
      cursor: candidate.cursor,
      limit: MAX_TERMINAL_READ_LIMIT
    })
    return {
      stream: {
        lines: stream.tail,
        truncated: stream.truncated,
        limited: stream.limited === true
      },
      // readVisibleTerminalState projects the grid with the active composer draft removed.
      screen: { lines: visibleState.lines }
    }
  }

  private listCurrentTerminalIdentityProofNames(
    worktreeId: string,
    exceptPtyId: string
  ): readonly (string | null)[] {
    const names: (string | null)[] = []
    for (const leaf of this.leaves.values()) {
      if (
        leaf.ptyId === exceptPtyId ||
        !leaf.ptyId ||
        !leaf.connected ||
        !leaf.writable ||
        !runtimeWorktreeIdsEqual(leaf.worktreeId, worktreeId)
      ) {
        continue
      }
      const pty = this.ptysById.get(leaf.ptyId)
      if (
        !pty?.connected ||
        !pty.incarnationId ||
        (this.leavesByPtyId.get(leaf.ptyId)?.length ?? 0) !== 1
      ) {
        continue
      }
      names.push(
        getLatestPtyTitle(pty) ?? getLatestLeafTitle(leaf, this.tabs.get(leaf.tabId)?.title ?? null)
      )
    }
    return names
  }

  private renameTerminalFromIdentityProof(
    challenge: TerminalIdentityProofChallenge,
    candidate: TerminalIdentityProofCandidate,
    title: string
  ): RuntimeTerminalIdentityProofComplete {
    if (!this.isCurrentTerminalIdentityProofCandidate(challenge.worktreeId, candidate)) {
      throw new Error('terminal_identity_proof_identity_changed')
    }
    const pty = this.ptysById.get(candidate.ptyId)
    if (!pty || pty.incarnationId !== candidate.incarnationId) {
      throw new Error('terminal_identity_proof_identity_changed')
    }
    pty.title = title
    pty.titleUpdatedAt = Date.now()
    this.touchMobileSessionSnapshotsForPty(candidate.ptyId)
    if (!this.notifier?.renameTerminal) {
      this.persistHeadlessTerminalTitle(challenge.worktreeId, candidate.tabId, title)
    }
    this.notifier?.renameTerminal(candidate.tabId, title)
    return {
      rename: { handle: candidate.handle, tabId: candidate.tabId, title },
      binding: {
        handle: candidate.handle,
        worktreeId: challenge.worktreeId,
        tabId: candidate.tabId,
        leafId: candidate.leafId,
        ptyId: candidate.ptyId,
        incarnationId: candidate.incarnationId,
        executionHostId: challenge.executionHostId,
        topologyRevision: challenge.topologyRevision
      }
    }
  }
}
