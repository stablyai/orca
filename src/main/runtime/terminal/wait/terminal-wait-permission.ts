import { OrcaRuntimeWithAgentPromptRequestCorrelation } from '../input/orca-runtime-agent-prompt-request-correlation'
import type { RuntimeTerminalAgentStatusSnapshot } from '../query/runtime-terminal-agent-status-query'
import { lastSupportedIndex } from '../../../../shared/terminal/output/terminal-supported-occurrences'
import { readTerminalActionText, type TerminalActionText } from '../output/terminal-action-text'
import { terminalTitleIsPredecessor } from '../input/terminal-command-paint'
import {
  joinedTerminalOrigins,
  terminalSupportQuery
} from '../../../../shared/terminal/output/terminal-content-origin'
import type { AgentStatus } from '../../../../shared/agent-status/title/agent-title-core'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/runtime-terminal-contracts'
import {
  detectExplicitIdleStatusFromTitle,
  detectTerminalWaitBlockedReason
} from './terminal-wait-detection'
import {
  judgeTerminalPermissionEvidence,
  resolveTerminalPermissionEvidence,
  type TerminalPermissionDecision
} from './terminal-permission-evidence'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type {
  RuntimePtyWorktreeRecord,
  RuntimeVisibleTerminalState
} from '../records/runtime-terminal-state-records'
import { renewRuntimeMobileAgentStatusFromPtyTitle } from '../../session-lifecycle/projection/runtime-mobile-agent-status-projection'
import { getDisplayPromptLifecycle } from '../../workspaces/process-listing/runtime-worktree-status-projection'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { hasExplicitIdleTitle } from './tui-idle-evidence'
import { readTuiIdleHookTurn, type TuiIdleHookTurn } from './tui-idle-hook-lane'
import { selectFreshExplicitAgentStatusRow } from '../../workspaces/process-listing/runtime-hook-agent-row-selection'
import { isClaudeDialogHoldingPane } from './claude-open-dialog-hold'

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
    ptyId: string,
    paneAgent: TerminalAgent | null = this.getPaneAgentForTuiIdle(ptyId)
  ): TerminalInteractiveWaitEvidence | Promise<TerminalInteractiveWaitEvidence | undefined> {
    if (paneAgent !== 'claude' || !this.headlessTerminals.has(ptyId)) {
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
    if (observed) {
      const joined = joinedTerminalOrigins(screen.lines)
      terminal.waitTextSupport = terminalSupportQuery(
        joined.origins,
        this.ptysById.get(ptyId)?.commandPaint?.contentOrigin
      )
    }
    const explicitStatus = this.getFreshExplicitAgentStatusForHandle(handle, ptyId)
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
    return resolveTerminalPermissionEvidence(terminal, explicitStatus, lifecycle, observedOnScreen)
  }

  protected readCommonTerminalPermission(
    ptyId: string,
    action: TerminalActionText,
    candidate: RuntimeTerminalWaitBlockedReason | null,
    screen?: readonly string[] | null
  ): TerminalPermissionDecision {
    const handle =
      this.handleByPtyId.get(ptyId) ?? this.getExistingTerminalHandlesForPtyId(ptyId)[0]
    if (!handle || this.getTerminalAgentStatusPtyId(handle) !== ptyId) {
      return candidate ? { kind: 'unresolved', reason: candidate } : { kind: 'none' }
    }
    const { terminal, lifecycle } = this.getTerminalWaitPermissionInputs(handle, ptyId)
    terminal.waitText = action.text
    terminal.waitTextSupport = action.query
    const lines =
      screen === undefined
        ? this.getPaneAgentForTuiIdle(ptyId) === 'claude'
          ? this.readCaughtUpProjectedScreen(ptyId)
          : this.readCaughtUpRuledScreen(ptyId)?.lines
        : screen
    if (lines) {
      const joined = joinedTerminalOrigins(lines)
      const reason = detectTerminalWaitBlockedReason(
        joined.text,
        terminalSupportQuery(joined.origins, this.ptysById.get(ptyId)?.commandPaint?.contentOrigin)
      )
      if (reason) {
        return { kind: 'current', reason }
      }
    }
    if (!candidate) {
      return { kind: 'none' }
    }
    return judgeTerminalPermissionEvidence(
      terminal,
      this.getFreshExplicitAgentStatusForHandle(handle, ptyId),
      lifecycle,
      false,
      candidate
    )
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
    const pty = this.ptysById.get(ptyId)
    const action = pty ? readTerminalActionText(pty) : undefined
    if (
      action?.query &&
      (waitTextOverride === undefined
        ? snapshot.waitText === action.text || action.text === ''
        : waitTextOverride === action.text)
    ) {
      snapshot.waitText = action.text
      snapshot.waitTextSupport = action.query
    }
    if (pty && terminalTitleIsPredecessor(pty)) {
      snapshot.titleStatusIsLive = false
    }
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
      hasExplicitIdleTitle: !terminalTitleIsPredecessor(pty) && hasExplicitIdleTitle(pty),
      respawnedAt: this.agentPromptExplicitStatusFloorByPtyId.get(ptyId),
      lastInputAt: this.terminalRunFacts.readLastInputAt(ptyId),
      tailIncludes: (text) => {
        const action = readTerminalActionText(pty)
        return lastSupportedIndex(action.text, text, action.query) !== -1
      },
      resolveBlockedText: (state, row) =>
        this.resolveTuiIdleHookBlockedText(ptyId, handles, state, row)
    })
  }

  protected isPtyAwaitingUserInput(ptyId: string): boolean {
    const join = this.readHookRowJoinForPty(ptyId)
    return isClaudeDialogHoldingPane({
      row: join ? selectFreshExplicitAgentStatusRow(join) : null,
      respawnedAt: this.agentPromptExplicitStatusFloorByPtyId.get(ptyId),
      readScreenLines: () => this.readLiveTerminalScreenLines(ptyId),
      contentScope: this.ptysById.get(ptyId)?.commandPaint?.contentOrigin
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
        this.getTerminalWaitPermissionInputs(handle, ptyId).terminal,
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

  protected assertAgentPromptGeneration(ptyId: string, expected: number): void {
    if (this.getPtyLifecycleGeneration(ptyId) !== expected) {
      throw new Error('terminal_handle_stale')
    }
  }
}
