import { OrcaRuntimeWithAgentPromptRequestCorrelation } from '../../orca-runtime-agent-prompt-request-correlation'
import type { RuntimeTerminalAgentStatusSnapshot } from '../../runtime-terminal-agent-status-query'
import type { AgentStatus } from '../../../../shared/agent-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/runtime-terminal-contracts'
import {
  detectExplicitIdleStatusFromTitle,
  detectTerminalWaitBlockedReason
} from '../../terminal-wait-detection'
import { isOpenCodeNativeTitle } from '../../../../shared/agent-detection'
import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type {
  RuntimePtyWorktreeRecord,
  RuntimeVisibleTerminalState
} from '../../runtime-terminal-state-records'
import { renewRuntimeMobileAgentStatusFromPtyTitle } from '../../runtime-mobile-agent-status-projection'
import { getDisplayPromptLifecycle } from '../../runtime-worktree-status-projection'
import type { RuntimeTerminalWriteOptions } from '../../runtime-terminal-writer'
import type { WriteSettlement } from '../../../../shared/pty-write-settlement'
import { resolvePtyWriteHostPlatform } from '../input/pty-write-host-platform'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { TerminalAgent } from '../../../../shared/terminal-agent'
import type { AgentPromptActivity } from '../../agent-prompt-submission-verification'
import { hasExplicitIdleTitle } from '../../tui-idle-evidence'
import {
  readTuiIdleHookTurn,
  retainedTailIncludes,
  type TuiIdleHookTurn
} from '../../tui-idle-hook-lane'
import { selectFreshExplicitAgentStatusRow } from '../../runtime-hook-agent-row-selection'
import { isClaudeDialogHoldingPane } from '../../claude-open-dialog-hold'

import type { OrcaRuntimeWithStopExactTerminalsForWorktree } from '../stop/worktree-terminal-stop-targets'

export type TerminalWaitPermissionInputs = ReturnType<
  OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission['getTerminalWaitPermissionInputs']
>

export type TerminalWaitStatusEvidence = Parameters<
  OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission['resolveAuthoritativeTerminalWaitPermission']
>[1]

export type TerminalInteractiveWaitEvidence = {
  terminal: RuntimeTerminalAgentStatusSnapshot
  explicitStatus: TerminalWaitStatusEvidence
  promptReason: RuntimeTerminalWaitBlockedReason | null
  unconfirmed: boolean
}

export abstract class OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission extends OrcaRuntimeWithAgentPromptRequestCorrelation {
  protected abstract getExistingTerminalHandlesForPtyId(
    ...args: Parameters<
      OrcaRuntimeWithStopExactTerminalsForWorktree['getExistingTerminalHandlesForPtyId']
    >
  ): ReturnType<OrcaRuntimeWithStopExactTerminalsForWorktree['getExistingTerminalHandlesForPtyId']>

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

  /** Undefined when the pane changed or exited during a screen read; the caller then has no answer. */
  protected readTerminalInteractiveWaitEvidence(
    handle: string,
    ptyId: string
  ): TerminalInteractiveWaitEvidence | Promise<TerminalInteractiveWaitEvidence | undefined> {
    if (this.getPaneAgentForTuiIdle(ptyId) !== 'claude' || !this.headlessTerminals.has(ptyId)) {
      return this.buildTerminalInteractiveWaitEvidence(handle, ptyId, 'not-read')
    }
    return this.readCurrentTerminalWaitScreen(ptyId).then((screen) =>
      this.getTerminalAgentStatusPtyId(handle) !== ptyId || screen === undefined
        ? undefined
        : this.buildTerminalInteractiveWaitEvidence(handle, ptyId, screen)
    )
  }

  private buildTerminalInteractiveWaitEvidence(
    handle: string,
    ptyId: string,
    screen: RuntimeVisibleTerminalState | null | 'not-read'
  ): TerminalInteractiveWaitEvidence {
    const observed = screen !== null && screen !== 'not-read'
    // Why the rendered screen: Claude parks the cursor inside its dialog, and the line tail drops rows below it.
    const { terminal, lifecycle } = this.getTerminalWaitPermissionInputs(
      handle,
      ptyId,
      observed ? screen.lines.join('\n') : undefined
    )
    const explicitStatus = this.getFreshExplicitAgentStatusForHandle(handle)
    return {
      terminal,
      explicitStatus,
      promptReason: this.resolveAuthoritativeTerminalWaitPermission(
        terminal,
        explicitStatus,
        lifecycle,
        observed
      ),
      // A Claude dialog could not be ruled out: no screen, no hook status, no live working/idle title.
      unconfirmed:
        screen === null && !explicitStatus && !this.hasConfirmedNonPermissionTitle(terminal)
    }
  }

  private hasConfirmedNonPermissionTitle(terminal: RuntimeTerminalAgentStatusSnapshot): boolean {
    return (
      terminal.titleStatusIsLive &&
      (terminal.titleStatus === 'working' ||
        detectExplicitIdleStatusFromTitle(terminal.title ?? '') === 'idle')
    )
  }

  protected resolveAuthoritativeTerminalWaitPermission(
    terminal: RuntimeTerminalAgentStatusSnapshot,
    explicitStatus: { status: AgentStatus; updatedAt: number } | null,
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined,
    observedOnScreen = false
  ): RuntimeTerminalWaitBlockedReason | null {
    const blockedByWaitText = detectTerminalWaitBlockedReason(terminal.waitText)
    if (!blockedByWaitText) {
      return null
    }
    const liveTitleClearsBlockedText =
      terminal.titleStatusIsLive &&
      terminal.titleStatus !== null &&
      terminal.titleStatus !== 'permission' &&
      (!observedOnScreen ||
        terminal.titleStatus !== 'idle' ||
        detectExplicitIdleStatusFromTitle(terminal.title ?? '') === 'idle') &&
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
    return (observedOnScreen && newestClearAt < 0) ||
      (newestPermissionAt >= 0 && newestPermissionAt >= newestClearAt)
      ? blockedByWaitText
      : null
  }

  /** Compare display-projected title and lifecycle together; mixing an echoed stale-working clear with native lifecycle can hide a later dialog. */
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
    const join = this.readHookRowJoinForPty(ptyId)
    if (!pty || !join) {
      return null
    }
    const { handles, paneKeys, hookRows } = join
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
      tailIncludes: (text) => retainedTailIncludes(pty.tailBuffer, pty.tailPartialLine, text),
      resolveBlockedText: (state, row) =>
        this.resolveTuiIdleHookBlockedText(ptyId, handles, state, row)
    })
  }

  protected isPtyAwaitingUserInput(ptyId: string): boolean {
    const join = this.readHookRowJoinForPty(ptyId)
    return isClaudeDialogHoldingPane({
      row: join ? selectFreshExplicitAgentStatusRow(join) : null,
      respawnedAt: this.agentPromptExplicitStatusFloorByPtyId.get(ptyId),
      readScreenLines: () => this.readLiveTerminalScreenLines(ptyId)
    })
  }

  private readHookRowJoinForPty(ptyId: string): {
    handles: string[]
    paneKeys: Set<string>
    hookRows: readonly AgentStatusIpcPayload[]
  } | null {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return null
    }
    const paneKeys = this.collectPaneKeysForPty(ptyId)
    const ptyPaneKey = this.paneOfPty(pty).paneKey
    if (ptyPaneKey) {
      paneKeys.add(ptyPaneKey)
    }
    const readPane = this.getAgentStatusSnapshotForPaneFn
    const hookRows = readPane
      ? [...new Set([...paneKeys].flatMap((key) => readPane(key)))]
      : this.getAgentStatusSnapshotFn?.()
    return hookRows
      ? { handles: this.getExistingTerminalHandlesForPtyId(ptyId), paneKeys, hookRows }
      : null
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

  protected getPtyWriteHostPlatform(ptyId: string): NodeJS.Platform {
    return resolvePtyWriteHostPlatform(this.ptysById.get(ptyId))
  }

  protected getPtyAgent(ptyId: string): TerminalAgent | null {
    const pty = this.ptysById.get(ptyId)
    return pty?.launchAgent ?? pty?.foregroundAgent ?? null
  }

  protected isAgentPromptPermissionBlocked(
    baseline: AgentPromptActivity,
    current: AgentPromptActivity
  ): boolean {
    return (
      current.status === 'permission' || current.permissionSequence > baseline.permissionSequence
    )
  }

  protected assertAgentPromptPermissionSafe(
    baseline: AgentPromptActivity,
    current: AgentPromptActivity
  ): void {
    if (this.isAgentPromptPermissionBlocked(baseline, current)) {
      throw new Error('agent_prompt_blocked')
    }
  }

  protected assertAgentPromptGeneration(ptyId: string, expected: number): void {
    if (this.getPtyLifecycleGeneration(ptyId) !== expected) {
      throw new Error('terminal_handle_stale')
    }
  }
}
