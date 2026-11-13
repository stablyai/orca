import { readTerminalComposerTypedText } from '../../../../shared/terminal/input/terminal-composer-draft'
import type { MailboxForeground } from '../../terminal/wait/launched-agent-foreground'
import type { TerminalIdentityReadContext } from '../../terminal/query/terminal-identity-read-context'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness } from '../../terminal/lifecycle/floating-session-liveness'
import { writeOrchestrationPointerWithSettlement } from '../mailbox/terminal-pointer/mailbox-pointer-pty-write'
import type { WriteSettlement } from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import type { RuntimeLeafRecord } from '../../terminal/records/runtime-terminal-state-records'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getPtyExecutionHost } from '../../../../shared/terminal/pty/lifecycle/terminal-execution-host'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { selectRuntimeHookAgentRowForPane } from '../../session-lifecycle/projection/runtime-mobile-agent-status-projection'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { resolvePublishedPaneAgentIdentity } from '../../../../shared/published-pane-agent-identity'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-terminal-contracts'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import { getLatestLeafTitle } from '../../workspaces/process-listing/runtime-worktree-status-projection'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { OrchestrationMailboxPointerSubmitTarget } from '../mailbox/terminal-pointer/mailbox-pointer-submit'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { startedMainTerminalSurfaces } from '../../terminal/surface/main-terminal-surfaces'
import { mainPaneVerdict } from '../../terminal/surface/main-pane-verdict'

export abstract class OrcaRuntimeWithWriteOrchestrationPointerPty extends OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness {
  protected abstract issueHandle(
    leaf: RuntimeLeafRecord,
    context?: TerminalIdentityReadContext
  ): string

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

  protected readMailboxComposerText(ptyId: string): string | null {
    return readTerminalComposerTypedText(
      this.readWholeScreenModel(ptyId)?.emulator.getCursorLineContext()
    )
  }

  /** The terminal a staged pointer's Enter goes to, re-read so a replaced process gets none. */
  protected resolveOrchestrationPointerSubmitTarget(
    ptyId: string,
    foreground?: MailboxForeground,
    stagedText?: string
  ): OrchestrationMailboxPointerSubmitTarget | null {
    const terminal = this.getOrchestrationMailboxTerminal(ptyId)
    const processIncarnation = terminal && this.getTerminalProcessIncarnation(terminal.handle)
    return processIncarnation
      ? {
          terminal: this.mailboxTerminalAdmission(terminal, foreground, stagedText),
          processIncarnation
        }
      : null
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

  /** A user's pane name from the saved layout: every client's pane rename lands there. */
  protected getSavedPaneTitle(worktreeId: string, tabId: string, leafId: string): string | null {
    const layout = this.getWorkspaceSessionForWorktree(worktreeId)?.terminalLayoutsByTabId?.[tabId]
    return layout?.titlesByLeafId?.[leafId]?.trim() || null
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
    const paneTitle = this.getSavedPaneTitle(leaf.worktreeId, leaf.tabId, leaf.leafId)
    // Demote only controller-proven local absence; remote inventory gaps are unknown, and hasPty rescues spawn/list races.
    const provenAbsent =
      provenLivePtyIds !== null &&
      leaf.ptyId !== null &&
      !provenLivePtyIds.has(leaf.ptyId) &&
      !isRemoteRuntimePtyId(leaf.ptyId) &&
      parseAppSshPtyId(leaf.ptyId) === null &&
      this.ptyController?.hasPty?.(leaf.ptyId) !== true
    const mainPane = ORCA_LAYOUT_OWNER_IS_MAIN
      ? (startedMainTerminalSurfaces(this)?.paneOf(leaf.tabId, leaf.leafId) ?? null)
      : null
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
      ...(paneTitle ? { paneTitle } : {}),
      connected: provenAbsent ? false : leaf.connected,
      writable: provenAbsent ? false : leaf.writable,
      // A pane with a status is never connected; its verdict says what the host knows.
      ...(ORCA_LAYOUT_OWNER_IS_MAIN && mainPane?.hasStatus
        ? { connected: false, writable: false }
        : {}),
      lastOutputAt: leaf.lastOutputAt,
      preview: leaf.preview,
      ...(leaf.lastExitCause ? { exitCause: leaf.lastExitCause } : {}),
      ...this.terminalExecutionHostField(leaf.ptyId, leaf.worktreeId),
      ...this.resolvePaneAgentIdentityField(
        pty?.launchAgent ?? pty?.launchCommandAgent,
        pty?.foregroundAgent,
        title,
        isTerminalLeafId(leaf.leafId) ? makePaneKey(leaf.tabId, leaf.leafId) : null
      ),
      ...(ORCA_LAYOUT_OWNER_IS_MAIN && mainPane
        ? {
            verdict: mainPaneVerdict(mainPane, {
              ptysById: this.ptysById,
              livenessOf: (ptyId) => this.getPtyLivenessVerdict(ptyId),
              inventoryLivePtyIds: provenLivePtyIds,
              controllerHasPty: (ptyId) => this.ptyController?.hasPty?.(ptyId) === true
            })
          }
        : {})
    }
  }
}
