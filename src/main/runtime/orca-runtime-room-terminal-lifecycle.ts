import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { AGENT_COMPACT_COMMAND } from '../../shared/agent-compaction'
import type { ClaudeStatusLineRateLimits } from '../../shared/claude-statusline-rate-limits'
import type {
  RuntimeMobileSessionTerminalTab,
  RuntimeTerminalClose,
  RuntimeTerminalFocus,
  RuntimeTerminalSend
} from '../../shared/runtime-types'
import type { RoomEvent, RoomParticipant } from '../../shared/rooms'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TuiAgent } from '../../shared/tui-agent'
import { OrcaRuntimeWithRoomAttachments } from './orca-runtime-room-attachments'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import { resolveTerminalSessionWorktreeId } from './runtime-worktree-path-identity'
import { terminalLayoutContainsLeaf } from './headless-terminal-split-layout'
import { waitForWorktreeStartupDraft } from './runtime-worktree-startup-readiness'

export abstract class OrcaRuntimeWithRoomTerminalLifecycle extends OrcaRuntimeWithRoomAttachments {
  emitRoomEvent(roomId: string, event: RoomEvent): void {
    this.notifier?.roomEvent?.(roomId, event)
    if (event.type === 'message.created' && event.message.actorKind === 'agent') {
      this.emitClientEvent({ type: 'roomEvent', roomId, event })
    }
  }

  ingestRoomAgentStatus(event: AgentHookEventPayload & { receivedAt: number }): void {
    this.roomService?.ingestAgentStatus(event)
  }

  ingestRoomClaudeStatusLine(event: ClaudeStatusLineRateLimits): void {
    this.roomService?.ingestClaudeStatusLine(event)
  }

  getRoomDeliveryIdForPaneKey(paneKey: string): string | undefined {
    return this.roomService?.currentTurnDeliveryIdForPane(paneKey) ?? undefined
  }

  shouldPublishAgentStatusToRenderer(paneKey: string): boolean {
    const participant = this.roomService?.participantForPane(paneKey)
    return !participant || participant.terminalSurfaceVisible === true
  }

  override getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined {
    return (
      super.getAgentStatusTerminalHandleForPaneKey(paneKey) ??
      this.roomService?.participantForPane(paneKey)?.terminalHandle ??
      undefined
    )
  }

  publishRoomAgentProviderSession(
    handle: string,
    agent: string,
    providerSession: AgentProviderSessionMetadata,
    force = false
  ): void {
    const paneKey = this.getTerminalPaneKey(handle)
    const pty = this.getLivePtyForHandle(handle)
    if (!paneKey || !pty || !this.onTerminalAgentStatus) {
      return
    }
    const rows = this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? []
    const known = rows.find((row) => row.providerSession?.id === providerSession.id)
    if (!force && known?.providerSession?.transcriptPath === providerSession.transcriptPath) {
      return
    }
    const state = rows[0]?.state ?? 'done'
    this.onTerminalAgentStatus({
      ptyId: pty.pty.ptyId,
      source: 'pty-record',
      paneKey,
      tabId: pty.pty.tabId ?? undefined,
      worktreeId: pty.pty.worktreeId,
      connectionId: pty.pty.connectionId,
      providerSession,
      ...(force ? { force: true } : {}),
      payload: {
        state,
        prompt: '',
        agentType: agent,
        ...(state === 'done' ? { sessionBoundary: true } : {})
      }
    })
  }

  async waitForTerminalAgentInputReady(handle: string, agent: TuiAgent): Promise<boolean> {
    const abort = new AbortController()
    try {
      const ready = waitForWorktreeStartupDraft(
        this.getWorktreeStartupReadinessHost(),
        handle,
        agent
      )
      const exited = this.waitForTerminal(handle, {
        condition: 'exit',
        signal: abort.signal
      }).then(() => null)
      return (await Promise.race([ready, exited])) !== null
    } finally {
      abort.abort()
    }
  }

  compactTerminalAgentSession(handle: string): Promise<RuntimeTerminalSend> {
    return this.sendTerminalAgentPrompt(handle, AGENT_COMPACT_COMMAND)
  }

  hasPersistedTerminalSurface(worktreeId: string, paneKey: string): boolean {
    const pane = parsePaneKey(paneKey)
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    const sessionWorktreeId = session ? resolveTerminalSessionWorktreeId(session, worktreeId) : null
    if (!pane || !session || !sessionWorktreeId) {
      return false
    }
    const tab = session.tabsByWorktree[sessionWorktreeId]?.find(
      (candidate) =>
        candidate.id === pane.tabId && runtimeWorktreeIdsEqual(candidate.worktreeId, worktreeId)
    )
    const layout = session.terminalLayoutsByTabId?.[pane.tabId]
    return Boolean(tab && layout && terminalLayoutContainsLeaf(layout.root, pane.leafId))
  }

  async hideRoomTerminalSurfaceFromRenderer(tabId: string): Promise<void> {
    const pty = [...this.ptysById.values()].find((candidate) => candidate.tabId === tabId)
    const participant = pty?.paneKey ? this.roomService?.participantForPane(pty.paneKey) : null
    if (!participant?.terminalHandle) {
      return
    }
    this.roomService?.hideParticipantTerminal(participant.terminalHandle)
    await this.removeRoomTerminalSurface({ ...participant, terminalSurfaceVisible: false }, false)
  }

  protected shouldPreserveTerminalSessionOnClose(handle: string): boolean {
    return this.roomService?.participantForTerminal(handle) != null
  }

  override async focusTerminal(
    handle: string,
    options: { navigateHost?: boolean; viewMode?: 'terminal' | 'chat' } = {}
  ): Promise<RuntimeTerminalFocus> {
    const participant = this.roomService?.participantForTerminal(handle)
    const live = this.getLivePtyForHandle(handle)
    if (participant && !participant.terminalSurfaceVisible && live) {
      const pane = parsePaneKey(participant.paneKey ?? '')
      if (!pane) {
        throw new Error('room_participant_not_ready')
      }
      live.pty.tabId = pane.tabId
      live.pty.paneKey = participant.paneKey
      const hasPublishedSurface = this.mobileSessionTabsByWorktree
        .get(live.pty.worktreeId)
        ?.tabs.some(
          (candidate) =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === pane.tabId &&
            candidate.leafId === pane.leafId
        )
      if (!hasPublishedSurface) {
        this.publishPtyBackedMobileSessionTerminal(live.pty.worktreeId, live.pty, {
          tabId: pane.tabId,
          leafId: pane.leafId,
          title: null,
          activate: true,
          ...(options.viewMode ? { viewMode: options.viewMode } : {})
        })
      }
    }
    return super.focusTerminal(handle, options)
  }

  override async closeTerminal(
    handle: string,
    options?: { force?: boolean; waitForExit?: boolean }
  ): Promise<RuntimeTerminalClose> {
    const live = this.getLivePtyForHandle(handle)
    if (!options?.force && live && this.roomService?.participantForTerminal(handle)) {
      this.roomService.hideParticipantTerminal(handle)
      return { handle, tabId: live.pty.tabId ?? live.record.tabId, ptyKilled: false }
    }
    return super.closeTerminal(handle)
  }

  override async closeTerminalTab(handle: string): Promise<RuntimeTerminalClose> {
    const live = this.getLivePtyForHandle(handle)
    if (live && this.roomService?.participantForTerminal(handle)) {
      return {
        handle,
        tabId: live.pty.tabId ?? live.record.tabId,
        closeMode: 'tab',
        ptyKilled: false
      }
    }
    return super.closeTerminalTab(handle)
  }

  override getTerminalPaneKey(handle: string): string | null {
    return (
      super.getTerminalPaneKey(handle) ??
      this.roomService?.participantForTerminal(handle)?.paneKey ??
      null
    )
  }

  private async removeRoomTerminalSurface(
    participant: RoomParticipant,
    notifyRenderer: boolean
  ): Promise<void> {
    if (!participant.worktreeId || !participant.paneKey) {
      return
    }
    const pane = parsePaneKey(participant.paneKey)
    if (!pane) {
      return
    }
    const snapshot = this.mobileSessionTabsByWorktree.get(participant.worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionTerminalTab =>
        candidate.type === 'terminal' && candidate.parentTabId === pane.tabId
    )
    try {
      let removedSurface = false
      if (snapshot && tab) {
        this.closeHeadlessMobileTerminalTab(participant.worktreeId, snapshot, tab, {
          allowMissingPersistedTab: true,
          killPtys: false
        })
        removedSurface = true
      } else if (this.hasPersistedTerminalSurface(participant.worktreeId, participant.paneKey)) {
        this.commitHeadlessTerminalTabRetirement(participant.worktreeId, pane.tabId, {
          allowMissing: true
        })
        removedSurface = true
      }
      if (notifyRenderer && removedSurface) {
        this.notifyRendererOfHeadlessTerminalClose(pane.tabId, {
          preserveSessionOnClose: true
        })
      }
    } catch (error) {
      console.warn('[rooms] failed to hide background participant terminal surface', error)
    }
  }
}
