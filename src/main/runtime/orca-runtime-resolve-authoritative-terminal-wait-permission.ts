// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithAgentPromptRequestCorrelation } from './orca-runtime-agent-prompt-request-correlation'
import type { RuntimeTerminalAgentStatusSnapshot } from './runtime-terminal-agent-status-query'
import type { AgentStatus } from '../../shared/agent-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'
import { isOpenCodeNativeTitle } from '../../shared/agent-detection'
import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { renewRuntimeMobileAgentStatusFromPtyTitle } from './runtime-mobile-agent-status-projection'
import { getDisplayPromptLifecycle } from './runtime-worktree-status-projection'
import type { RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import type { WriteSettlement } from '../../shared/pty-write-settlement'
import { getRegisteredSshState } from '../ssh/ssh-target-registry'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalAgent } from '../../shared/terminal-agent'
import type { AgentPromptActivity } from './agent-prompt-submission-verification'
import { hasExplicitIdleTitle } from './tui-idle-evidence'
import { readTuiIdleHookTurn, type TuiIdleHookTurn } from './tui-idle-hook-lane'

export class OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission extends OrcaRuntimeWithAgentPromptRequestCorrelation {
  readOpenCodeStartupPromptOwner(ptyId: string, incarnationId: string, launchToken: string) {
    const pty = this.ptysById.get(ptyId)
    if (!pty || pty.incarnationId !== incarnationId) {
      return null
    }
    // The runtime launch route admits identity immediately after low-level spawn returns.
    if (pty.launchToken === null && pty.launchAgent === null && pty.launchIncarnationId === null) {
      return 'pending' as const
    }
    if (
      pty.launchIncarnationId !== incarnationId ||
      pty.launchToken !== launchToken ||
      (pty.launchAgent !== 'opencode' && pty.launchAgent !== 'opencode2')
    ) {
      return null
    }
    return this.terminalRunFacts.read(ptyId, incarnationId)
  }

  protected resolveAuthoritativeTerminalWaitPermission(
    terminal: RuntimeTerminalAgentStatusSnapshot,
    explicitStatus: { status: AgentStatus; updatedAt: number } | null,
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
  ): RuntimeTerminalWaitBlockedReason | null {
    const blockedByWaitText = detectTerminalWaitBlockedReason(terminal.waitText)
    if (!blockedByWaitText) {
      return null
    }
    const liveTitleClearsBlockedText =
      terminal.titleStatusIsLive &&
      terminal.titleStatus !== null &&
      terminal.titleStatus !== 'permission' &&
      !isOpenCodeNativeTitle(terminal.title) &&
      blockedByWaitText !== 'agent-approval-prompt'
    if (liveTitleClearsBlockedText && lifecycle?.status !== terminal.titleStatus) {
      return null
    }
    if (blockedByWaitText === 'agent-approval-prompt') {
      return blockedByWaitText
    }
    const newestPermissionAt = Math.max(
      explicitStatus?.status === 'permission' ? explicitStatus.updatedAt : -1,
      lifecycle?.status === 'permission' ? lifecycle.updatedAt : -1,
      terminal.waitBlockedAt ?? -1
    )
    const newestClearAt = Math.max(
      explicitStatus && explicitStatus.status !== 'permission' ? explicitStatus.updatedAt : -1,
      lifecycle?.status && lifecycle.status !== 'permission' ? lifecycle.updatedAt : -1
    )
    return newestPermissionAt >= 0 && newestPermissionAt >= newestClearAt ? blockedByWaitText : null
  }

  /**
   * The title snapshot and prompt lifecycle the blocked-dialog check compares, both as display
   * shows them, so the check reaches main's verdict: main compared the pair a stale-working clear
   * left, and comparing a renderer's echoed clear with the native lifecycle hid a later dialog.
   */
  protected getTerminalWaitPermissionInputs(
    handle: string,
    ptyId: string,
    waitTextOverride?: string
  ): {
    terminal: RuntimeTerminalAgentStatusSnapshot
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
  } {
    const clear = this.getPtyTitleDisplayClear(ptyId)
    const snapshot = this.terminalAgentStatus.getSnapshot(handle, ptyId, clear)
    return {
      terminal:
        waitTextOverride === undefined ? snapshot : { ...snapshot, waitText: waitTextOverride },
      lifecycle: getDisplayPromptLifecycle(this.agentPromptLifecycleByPtyId.get(ptyId), clear)
    }
  }

  /** The pane's main-agent turn from the hook server's store, for tui-idle's hook lane. */
  protected readTuiIdleHookTurnForPty(ptyId: string, agent: TuiAgent): TuiIdleHookTurn | null {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return null
    }
    const handles = this.getExistingTerminalHandlesForPtyId(ptyId)
    const paneKeys = this.collectPaneKeysForPty(ptyId)
    if (pty.paneKey) {
      paneKeys.add(pty.paneKey)
    }
    const readPane = this.getAgentStatusSnapshotForPaneFn
    const hookRows = readPane
      ? [...new Set([...paneKeys].flatMap((key) => readPane(key)))]
      : this.getAgentStatusSnapshotFn?.()
    if (!hookRows) {
      return null
    }
    return readTuiIdleHookTurn({
      agent,
      handles,
      paneKeys,
      hookRows,
      connectionId: pty.connectionId,
      wslDistro: pty.wslDistro,
      launchToken: pty.launchToken,
      titleObservedAtEpochMs: pty.lastOscTitleEpochMs,
      hasExplicitIdleTitle: hasExplicitIdleTitle(pty),
      respawnedAt: this.agentPromptExplicitStatusFloorByPtyId.get(ptyId),
      lastInputAt: this.terminalRunFacts.readLastInputAt(ptyId),
      resolveBlockedText: (state, row) =>
        this.resolveTuiIdleHookBlockedText(ptyId, handles, state, row)
    })
  }

  private resolveTuiIdleHookBlockedText(
    ptyId: string,
    handles: readonly string[],
    state: 'done' | 'working' | 'permission',
    row: AgentStatusIpcPayload
  ): RuntimeTerminalWaitBlockedReason | null {
    const handle = this.handleByPtyId.get(ptyId) ?? handles[0]
    if (!handle) {
      return null
    }
    try {
      return this.resolveAuthoritativeTerminalWaitPermission(
        this.getTerminalAgentStatusSnapshot(handle, ptyId),
        { status: state === 'done' ? 'idle' : state, updatedAt: row.receivedAt },
        this.agentPromptLifecycleByPtyId.get(ptyId)
      )
    } catch {
      // A handle that no longer targets this PTY has no text to judge.
      return null
    }
  }

  renewMobileAgentStatusFromPtyTitle(
    status: AgentStatusEntry | null,
    pty: RuntimePtyWorktreeRecord | null,
    options: { preserveQuestionUnderShellTitle?: boolean } = {}
  ): AgentStatusEntry | null {
    return renewRuntimeMobileAgentStatusFromPtyTitle(status, pty, options)
  }

  protected writeTerminalAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    return this.terminalWriter.writeAction(ptyId, action, payload, options)
  }

  protected writeTerminalInputChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    return this.terminalWriter.writeChunks(ptyId, text, options)
  }

  /** Platform of the host whose pty transport ingests our writes -- deliberately NOT the OS
   *  the command runs under. A WSL pane is spawned as `wsl.exe` through the Windows ConPTY
   *  (see local-pty-provider), so it pays the ConPTY ingest cost even though its shell is
   *  Linux; an SSH pane is spawned by node-pty on the remote host, so the client's
   *  process.platform says nothing about it. */
  protected getPtyWriteHostPlatform(ptyId: string): NodeJS.Platform {
    const pty = this.ptysById.get(ptyId)
    const connectionId = pty?.connectionId
    if (!connectionId) {
      return process.platform
    }
    const remotePlatform = getRegisteredSshState(connectionId)?.remotePlatform
    if (remotePlatform) {
      return remotePlatform
    }
    // Why: remotePlatform only arrives with the relay handshake; until then the worktree path
    // flavor is the same signal getAgentLaunchPlatformForRepo already trusts for a remote repo.
    const worktreePath = pty ? splitWorktreeIdForFilesystem(pty.worktreeId)?.worktreePath : null
    return worktreePath && isWindowsAbsolutePathLike(worktreePath) ? 'win32' : 'linux'
  }

  protected getPtyAgent(ptyId: string): TerminalAgent | null {
    const pty = this.ptysById.get(ptyId)
    return pty?.launchAgent ?? pty?.foregroundAgent ?? null
  }

  protected assertAgentPromptPermissionSafe(
    baseline: AgentPromptActivity,
    current: AgentPromptActivity
  ): void {
    if (
      current.status === 'permission' ||
      current.permissionSequence > baseline.permissionSequence
    ) {
      throw new Error('agent_prompt_blocked')
    }
  }

  protected assertAgentPromptGeneration(ptyId: string, expected: number): void {
    if (this.getPtyLifecycleGeneration(ptyId) !== expected) {
      throw new Error('terminal_handle_stale')
    }
  }
}
