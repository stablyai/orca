// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness } from './orca-runtime-refresh-floating-workspace-pty-liveness'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import type { ExecutionHostId } from '../../shared/execution-host'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import type { TuiAgent } from '../../shared/tui-agent'
import { selectRuntimeHookAgentRowForPane } from './runtime-mobile-agent-status-projection'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { resolvePublishedPaneAgentIdentity } from '../../shared/published-pane-agent-identity'
import type { RuntimeTerminalSummary, RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-worktree-summary-paths'
import { parseRuntimeWorktreeId } from './runtime-worktree-path-identity'
import { findRuntimeWorktreeSummaryByPath } from './runtime-worktree-summary-paths'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { getLatestLeafTitle } from './runtime-worktree-status-projection'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'

export class OrcaRuntimeWithWriteOrchestrationPointerPty extends OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness {
  protected writeOrchestrationPointerPty(ptyId: string, data: string): boolean | Promise<boolean> {
    try {
      if (data === '\r') {
        const admitted = this.orchestrationPointerAdmissionByPtyId.get(ptyId)
        this.orchestrationPointerAdmissionByPtyId.delete(ptyId)
        if (admitted) {
          agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
        }
      } else {
        const admission = agentSessionPtyWriteGate.admit(ptyId)
        if (!admission.admitted) {
          this.orchestrationPointerAdmissionByPtyId.delete(ptyId)
          return this.ptyController?.write(ptyId, data) ?? false
        }
        this.orchestrationPointerAdmissionByPtyId.set(ptyId, {
          sessionId: admission.sessionId,
          runtimeFence: admission.runtimeFence
        })
      }
      return (
        this.ptyController?.writeWithSettlement?.(ptyId, data).catch(() => false) ??
        this.ptyController?.write(ptyId, data) ??
        false
      )
    } catch {
      return false
    }
  }

  protected getPrimaryLeafForPty(ptyId: string): RuntimeLeafRecord | null {
    return this.getLeavesForPty(ptyId)[0] ?? null
  }

  protected terminalExecutionHostField(
    ptyId: string | null,
    worktreeId: string
  ): { executionHostId?: ExecutionHostId } {
    const fromPtyId = getPtyExecutionHost(ptyId)
    if (fromPtyId === 'foreign') {
      return {}
    }
    const hostId = fromPtyId ?? this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    return hostId ? { executionHostId: hostId } : {}
  }

  protected resolvePaneAgentIdentityField(
    launchAgent: TuiAgent | null | undefined,
    foregroundAgent: TuiAgent | null | undefined,
    title: string | null,
    paneKey: string | null
  ): { agentIdentity?: TuiAgent } {
    const hookRow = paneKey
      ? selectRuntimeHookAgentRowForPane(this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? [])
      : null
    const hookAgent = isTuiAgent(hookRow?.agentType) ? hookRow.agentType : null
    const agentIdentity = resolvePublishedPaneAgentIdentity({
      hookAgent,
      hookIsLive: hookRow?.agentIsLive,
      launchAgent,
      foregroundAgent,
      title
    })
    return agentIdentity ? { agentIdentity } : {}
  }

  protected getSummaryForRuntimeWorktreeId(
    summaries: Map<string, RuntimeWorktreePsSummary>,
    runtimeWorktreeSummaryPathIndex: RuntimeWorktreeSummaryPathIndex,
    missingRuntimeWorktreeIds: Set<string>,
    runtimeWorktreeId: string
  ): RuntimeWorktreePsSummary | null {
    const exact = summaries.get(runtimeWorktreeId)
    if (exact) {
      return exact
    }
    if (missingRuntimeWorktreeIds.has(runtimeWorktreeId)) {
      return null
    }
    const parsed = parseRuntimeWorktreeId(runtimeWorktreeId)
    if (!parsed) {
      return null
    }
    const comparisonPlatform =
      runtimeWorktreeSummaryPathIndex.platformByRepoId.get(parsed.repoId) ?? process.platform
    const indexed = findRuntimeWorktreeSummaryByPath(
      runtimeWorktreeSummaryPathIndex,
      parsed.repoId,
      parsed.worktreePath,
      comparisonPlatform
    )
    if (indexed) {
      return indexed
    }
    missingRuntimeWorktreeIds.add(runtimeWorktreeId)
    return null
  }

  protected buildTerminalSummary(
    leaf: RuntimeLeafRecord,
    worktreesById: Map<string, ResolvedWorktree>,
    provenLivePtyIds: ReadonlySet<string> | null = null
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(leaf.worktreeId)
    const tab = this.tabs.get(leaf.tabId) ?? null

    const pty = leaf.ptyId ? this.ptysById.get(leaf.ptyId) : undefined
    const title = getLatestLeafTitle(leaf, tab?.title ?? null)
    // Why: leaf.connected mirrors the renderer graph (`ptyId !== null`), so a
    // restored surface whose PTY died with a prior run still reads connected.
    // Demote only on a controller-proven absence, and only for locally-scoped
    // ids the aggregate inventory authoritatively covers — SSH/remote scopes may
    // be legitimately missing from it, and unknown liveness never demotes.
    // The sync hasPty rescue closes the spawn/list race: a just-spawned PTY can
    // register after the inventory snapshot, and federation reads one
    // connected:false as exited.
    const provenAbsent =
      provenLivePtyIds !== null &&
      leaf.ptyId !== null &&
      !provenLivePtyIds.has(leaf.ptyId) &&
      !leaf.ptyId.startsWith('remote:') &&
      parseAppSshPtyId(leaf.ptyId) === null &&
      this.ptyController?.hasPty?.(leaf.ptyId) !== true
    return {
      handle: this.issueHandle(leaf),
      ptyId: leaf.ptyId,
      incarnationId: pty?.incarnationId ?? null,
      orphaned: false,
      worktreeId: leaf.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      title,
      connected: provenAbsent ? false : leaf.connected,
      writable: provenAbsent ? false : leaf.writable,
      lastOutputAt: leaf.lastOutputAt,
      preview: leaf.preview,
      ...(leaf.lastExitCause ? { exitCause: leaf.lastExitCause } : {}),
      ...this.terminalExecutionHostField(leaf.ptyId, leaf.worktreeId),
      ...this.resolvePaneAgentIdentityField(
        pty?.launchAgent,
        pty?.foregroundAgent,
        title,
        isTerminalLeafId(leaf.leafId) ? makePaneKey(leaf.tabId, leaf.leafId) : null
      )
    }
  }
}
