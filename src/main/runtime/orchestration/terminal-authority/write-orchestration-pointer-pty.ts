import type { TerminalIdentityReadContext } from '../../terminal/query/terminal-identity-read-context'
import { unmountedSleptLeafHandle } from '../mailbox/routing/unmounted-slept-leaf'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness } from '../../terminal/lifecycle/floating-session-liveness'
import { reportHeldMailNotice } from '../workers/turn-stops/held-mail-notice-report'
import { writeOrchestrationPointerWithSettlement } from '../mailbox/terminal-pointer/mailbox-pointer-pty-write'
import {
  getWindowsInputRecordPasteBurstMs,
  resolveAgentPromptSubmitDelayForAgent
} from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import type { OrchestrationPointerPty } from '../mailbox/terminal-pointer/mailbox-pointer-delivery-contract'
import type { RuntimeLeafRecord } from '../../terminal/records/runtime-terminal-state-records'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { getPtyExecutionHost } from '../../../../shared/terminal/pty/lifecycle/terminal-execution-host'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { selectRuntimeHookAgentRowForPane } from '../../session-lifecycle/projection/runtime-mobile-agent-status-projection'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { resolvePublishedPaneAgentIdentity } from '../../../../shared/agent-status/identity/published-pane-agent-identity'
import type { RuntimeTerminalSummary } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import { getLatestLeafTitle } from '../../workspaces/process-listing/runtime-worktree-status-projection'
import { parseAppSshPtyId } from '../../../../shared/remote-runtime/ssh/ssh-pty-id'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { OrchestrationMailboxPointerSubmitTarget } from '../mailbox/terminal-pointer/mailbox-pointer-submit'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { startedMainTerminalSurfaces } from '../../terminal/surface/main-terminal-surfaces'
import { mainPaneVerdict } from '../../terminal/surface/main-pane-verdict'

export abstract class OrcaRuntimeWithWriteOrchestrationPointerPty extends OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness {
  protected abstract issueHandle(
    leaf: RuntimeLeafRecord,
    context?: TerminalIdentityReadContext
  ): string

  protected orchestrationPointerPty(): OrchestrationPointerPty {
    return {
      writePty: (ptyId, data) =>
        writeOrchestrationPointerWithSettlement({ ptyId, data, controller: this.ptyController }),
      getWindowsPointerEnterDelayMs: (ptyId, pointer) =>
        this.getWindowsPointerEnterDelayMs(ptyId, pointer),
      armSubmitCheck: (handle, ptyId, pointer, isCurrent) =>
        this.armMailNoticeSubmitCheck(handle, ptyId, pointer, isCurrent),
      reportHeldNotice: (terminal, messageIds) => {
        this.terminalRunFacts.noteHeldMailNotice(terminal.ptyId)
        void reportHeldMailNotice(
          {
            getDb: () => this.getExistingOrchestrationDb(),
            getProcessIncarnation: (handle) => this.getTerminalProcessIncarnation(handle),
            readScreen: (handle) => this.readUnsubmittedWorkerScreen(handle),
            reportDeps: this.workerTurnStopReportDeps
          },
          terminal,
          messageIds
        ).catch(() => undefined)
      }
    }
  }

  /** On a Windows host, a pointer's Enter waits as a sent prompt's does: an input-record TUI such as
   *  Codex reads the text a key at a time and keeps an early Enter as a newline. */
  private getWindowsPointerEnterDelayMs(ptyId: string, pointer: string): number | null {
    const platform = this.getPtyWriteHostPlatform(ptyId)
    if (platform !== 'win32') {
      return null
    }
    const agent = this.getPtyAgent(ptyId)
    return (
      resolveAgentPromptSubmitDelayForAgent(platform, pointer, agent) +
      getWindowsInputRecordPasteBurstMs(platform, agent, pointer)
    )
  }

  /** The terminal a staged pointer's Enter goes to, re-read so a replaced process gets none. */
  protected resolveOrchestrationPointerSubmitTarget(
    ptyId: string
  ): OrchestrationMailboxPointerSubmitTarget | null {
    const terminal = this.getOrchestrationMailboxTerminal(ptyId)
    const processIncarnation = terminal && this.getTerminalProcessIncarnation(terminal.handle)
    return processIncarnation ? { terminal, processIncarnation } : null
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
    // An unmounted slept agent's pane carries its saved name; minting one would bind a placeholder.
    const handle = unmountedSleptLeafHandle(leaf) ?? this.issueHandle(leaf)
    // Agent Sleep's stopped process stands in for the idle agent it will resume.
    const sleptAgent = this.sleptAgentHandle(handle)
    const slept = sleptAgent ? (sleptAgent.pty ?? { lastOutputAt: null, preview: '' }) : null

    const pty =
      (leaf.ptyId ? this.ptysById.get(leaf.ptyId) : undefined) ?? sleptAgent?.pty ?? undefined
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
      handle,
      ptyId: leaf.ptyId,
      incarnationId: slept ? null : (pty?.incarnationId ?? null),
      orphaned: false,
      worktreeId: leaf.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      title,
      ...(paneTitle ? { paneTitle } : {}),
      connected: slept ? true : provenAbsent ? false : leaf.connected,
      writable: slept ? true : provenAbsent ? false : leaf.writable,
      // A pane with a status is never connected; its verdict says what the host knows.
      ...(ORCA_LAYOUT_OWNER_IS_MAIN && mainPane?.hasStatus
        ? { connected: false, writable: false }
        : {}),
      lastOutputAt: slept ? slept.lastOutputAt : leaf.lastOutputAt,
      preview: slept ? slept.preview : leaf.preview,
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
