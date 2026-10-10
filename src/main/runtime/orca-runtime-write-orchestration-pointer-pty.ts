// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { isRemoteRuntimePtyId } from '../../shared/remote-runtime-pty-id'
import { OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness } from './orca-runtime-refresh-floating-workspace-pty-liveness'
import { writeOrchestrationPointerWithSettlement } from './orchestration/mailbox-pointer-pty-write'
import type { WriteSettlement } from '../../shared/pty-write-settlement'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import type { ExecutionHostId } from '../../shared/execution-host'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalAgent } from '../../shared/terminal-agent'
import { selectRuntimeHookAgentRowForPane } from './runtime-mobile-agent-status-projection'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { resolvePublishedPaneAgentIdentity } from '../../shared/published-pane-agent-identity'
import type { RuntimeTerminalSummary } from '../../shared/runtime-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { getLatestLeafTitle } from './runtime-worktree-status-projection'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import type { OrchestrationMailboxLeaf } from './orchestration/mailbox-owner'
import type { OrchestrationMailboxPointerSubmitTarget } from './orchestration/mailbox-pointer-submit'

export class OrcaRuntimeWithWriteOrchestrationPointerPty extends OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness {
  protected writeOrchestrationPointerPty(
    ptyId: string,
    data: string
  ): WriteSettlement | Promise<WriteSettlement> {
    return writeOrchestrationPointerWithSettlement({
      ptyId,
      data,
      controller: this.ptyController
    })
  }

  // A parked leaf has left the renderer graph but its PTY is still addressable, so the pointer
  // target is rebuilt from the PTY record rather than refused.
  protected resolveOrchestrationPointerSubmitTarget(
    stagedLeaf: OrchestrationMailboxLeaf,
    ptyId: string
  ): OrchestrationMailboxPointerSubmitTarget | null {
    const leafKey = this.getLeafKey(stagedLeaf.tabId, stagedLeaf.leafId)
    const currentLeaf = this.leaves.get(leafKey)
    const parked = currentLeaf === undefined
    const terminalHandle = parked
      ? this.handleByPtyId.get(ptyId)
      : this.handleByLeafKey.get(leafKey)
    if (!terminalHandle) {
      return null
    }
    const pty = this.ptysById.get(ptyId)
    const leaf = parked
      ? pty?.connected &&
        pty.tabId === stagedLeaf.tabId &&
        isTerminalLeafId(stagedLeaf.leafId) &&
        pty.paneKey === makePaneKey(stagedLeaf.tabId, stagedLeaf.leafId)
        ? {
            ...stagedLeaf,
            writable: true,
            lastAgentStatus: pty.lastAgentStatus,
            lastAgentStatusObservedLive: pty.lastAgentStatusObservedLive,
            lastOscTitle: pty.lastOscTitle
          }
        : null
      : currentLeaf.ptyId === ptyId
        ? currentLeaf
        : null
    if (!leaf) {
      return null
    }
    const processIncarnation = this.getTerminalProcessIncarnation(terminalHandle)
    return processIncarnation ? { leaf, terminalHandle, processIncarnation } : null
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
    foregroundAgent: TerminalAgent | null | undefined,
    title: string | null,
    paneKey: string | null
  ): { agentIdentity?: TerminalAgent } {
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

  protected buildTerminalSummary(
    leaf: RuntimeLeafRecord,
    worktreesById: Map<string, ResolvedWorktree>,
    provenLivePtyIds: ReadonlySet<string> | null = null
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(leaf.worktreeId)
    const tab = this.tabs.get(leaf.tabId) ?? null

    const pty = leaf.ptyId ? this.ptysById.get(leaf.ptyId) : undefined
    const title = getLatestLeafTitle(this.getLeafDisplayRecord(leaf), tab?.title ?? null)
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
      !isRemoteRuntimePtyId(leaf.ptyId) &&
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
