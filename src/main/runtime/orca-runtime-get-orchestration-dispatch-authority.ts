// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller } from './orca-runtime-verify-orchestration-compatibility-caller'
import type { OrchestrationCompatibilityTerminalAuthority } from './runtime-terminal-contracts'
import { createHash } from 'node:crypto'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import { RECENT_PTY_OUTPUT_LIMIT, RecentPtyOutputBuffer } from './recent-pty-output-buffer'
import { appendRecentPtyPathCandidates } from './terminal-output-path-candidates'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  resolveTerminalOrchestrationCliCommand,
  type OrchestrationCliCommand
} from './orchestration/cli-command'

export class OrcaRuntimeWithGetOrchestrationDispatchAuthority extends OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller {
  /** Every pane key this PTY could be addressed by, including restored receipts. */
  protected collectPaneKeysForPty(ptyId: string): Set<string> {
    const paneKeys = new Set<string>()
    const pty = this.ptysById.get(ptyId)
    if (pty?.paneKey && parsePaneKey(pty.paneKey)) {
      paneKeys.add(pty.paneKey)
    }
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    if (receipt?.paneKey && parsePaneKey(receipt.paneKey)) {
      paneKeys.add(receipt.paneKey)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      if (isValidTerminalTabId(leaf.tabId) && isTerminalLeafId(leaf.leafId)) {
        paneKeys.add(makePaneKey(leaf.tabId, leaf.leafId))
      }
    }
    return paneKeys
  }

  getOrchestrationDispatchAuthority(
    terminalHandle: string
  ): OrchestrationCompatibilityTerminalAuthority | null {
    let ptyId: string | null
    try {
      ptyId =
        this.getLivePtyForHandle(terminalHandle)?.pty.ptyId ??
        this.resolveLiveLeafForHandle(terminalHandle)?.ptyId ??
        null
    } catch {
      return null
    }
    if (!ptyId) {
      return null
    }
    const pty = this.ptysById.get(ptyId)
    if (!pty?.connected) {
      return null
    }
    const hostScope = this.getOrchestrationCompatibilityHostScope(pty)
    if (!hostScope) {
      return null
    }
    return {
      runtimeId: this.runtimeId,
      terminalHandle,
      ptyId,
      worktreeId: pty.worktreeId,
      processIncarnation: this.getTerminalProcessIncarnation(terminalHandle),
      paneKey: pty.paneKey,
      launchTokenHash: pty.launchToken
        ? createHash('sha256').update(pty.launchToken).digest('hex')
        : null,
      hostScope
    }
  }

  protected retirePtyAgentLaunchAuthority(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return
    }
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    if (!pty.launchToken && !receipt && !pty.launchAgent) {
      return
    }
    // Why: collect before the delete below, which drops the restored-authority receipt a
    // receipt-only pane's key comes from.
    const paneKeys = this.collectPaneKeysForPty(ptyId)
    this.restoredOrchestrationAuthorityByPtyId.delete(ptyId)
    pty.launchToken = null
    pty.launchIncarnationId = null
    pty.launchAgent = null
    for (const paneKey of paneKeys) {
      this.retireAgentHookCompatibilityAuthorityFn?.(paneKey)
    }
  }

  async resolveTerminalCwd(handle: string): Promise<string | null> {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    if (!ptyId) {
      return null
    }
    const tracked = this.terminalCwdByPtyId.get(ptyId)
    if (tracked) {
      return tracked
    }
    try {
      const cwd = await this.ptyController?.getCwd?.(ptyId)
      return cwd && cwd.trim().length > 0 ? cwd : null
    } catch {
      return null
    }
  }

  resolveTerminalFileUriHostname(handle: string): string | null {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    return ptyId ? (this.terminalFileUriHostnameByPtyId.get(ptyId) ?? null) : null
  }

  protected recordRecentPtyOutputForPathProvenance(ptyId: string, data: string): void {
    let recentOutputBuffer = this.recentPtyOutputById.get(ptyId)
    if (!recentOutputBuffer) {
      // Boundaries are only owed to the one-time activation backfill; once
      // tracking is live, new buffers keep the read-collapsing hot path.
      recentOutputBuffer = new RecentPtyOutputBuffer({
        preserveChunkBoundaries: !this.recentPtyPathCandidateTrackingActive
      })
      this.recentPtyOutputById.set(ptyId, recentOutputBuffer)
    }
    recentOutputBuffer.append(data)
    if (
      this.recentPtyPathCandidateTrackingActive ||
      // Why: an over-window chunk is stored pre-sliced, so activation backfill
      // could never replay its original text. Extract while intact; oversized
      // chunks are rare, so the desktop-only gate still skips the hot path.
      data.length > RECENT_PTY_OUTPUT_LIMIT
    ) {
      this.recentPtyPathCandidatesById.set(
        ptyId,
        appendRecentPtyPathCandidates(this.recentPtyPathCandidatesById.get(ptyId), data)
      )
    }
  }

  activateRecentPtyPathCandidateTracking(): void {
    if (this.recentPtyPathCandidateTrackingActive) {
      return
    }
    this.recentPtyPathCandidateTrackingActive = true
    // Why: synchronous backfill from the retained raw windows so a file tap
    // right after first mobile connect resolves exactly as before the gate.
    // Replay each retained chunk in its original full form: joining or
    // trimming chunks would change the candidate set (e.g. a window cut can
    // shorten an over-4KiB line under the extractor's line guard, minting
    // candidates the eager extractor rejected).
    // Accepted best-effort loss: output that scrolled past the raw window
    // before the first-ever connect no longer yields candidates.
    for (const [ptyId, buffer] of this.recentPtyOutputById) {
      let candidates = this.recentPtyPathCandidatesById.get(ptyId)
      const { chunks, headChunkIsPartial } = buffer.retainedChunks()
      for (let index = 0; index < chunks.length; index += 1) {
        if (index === 0 && headChunkIsPartial) {
          // A pre-sliced over-window chunk was already extracted eagerly at
          // append time (while its original text was intact); replaying its
          // truncated remainder would mint or drop candidates spuriously.
          continue
        }
        candidates = appendRecentPtyPathCandidates(candidates, chunks[index]!)
      }
      if (candidates) {
        this.recentPtyPathCandidatesById.set(ptyId, candidates)
      }
      // Chunk boundaries were owed only to this one-time backfill; return
      // the buffer to the compact read-collapsing steady state.
      buffer.compact()
    }
  }

  resolveTerminalContext(
    handle: string
  ): { worktreeId: string; connectionId: string | null } | null {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    const pty = ptyId ? this.ptysById.get(ptyId) : null
    return pty ? { worktreeId: pty.worktreeId, connectionId: pty.connectionId } : null
  }

  // Why: remote clients cannot resolve this runtime's WSL project preference,
  // so host-affecting RPCs (skill discovery) resolve it from the owning store.
  resolveProjectRuntimeForWorktree(
    worktreeId: string | null | undefined
  ): ProjectExecutionRuntimeResolution | undefined {
    return this.store && worktreeId
      ? resolveLocalProjectRuntimeForWorktreeId(this.requireStore(), worktreeId)
      : undefined
  }

  getTerminalOrchestrationCliCommand(handle: string): OrchestrationCliCommand {
    let pty: RuntimePtyWorktreeRecord | null = null
    try {
      const ptyId = this.resolveLeafForHandle(handle)?.ptyId
      pty = ptyId ? (this.ptysById.get(ptyId) ?? null) : null
    } catch {
      return 'orca'
    }
    if (!pty) {
      return 'orca'
    }
    return resolveTerminalOrchestrationCliCommand({
      connectionId: pty.connectionId,
      isWsl: pty.isWsl,
      worktreeId: pty.worktreeId,
      projectRuntime: this.store
        ? resolveLocalProjectRuntimeForWorktreeId(this.requireStore(), pty.worktreeId)
        : undefined,
      devMode: process.env.ORCA_USER_DATA_PATH?.includes('orca-dev') === true
    })
  }
}
