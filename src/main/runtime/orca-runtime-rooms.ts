import { execFile } from 'node:child_process'
import { extname, join, posix, win32 } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { isAiVaultSessionInWorkspacePath } from '../../shared/ai-vault-session-filters'
import {
  isAiVaultSessionResumableContent,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import type { ClaudeStatusLineRateLimits } from '../../shared/claude-statusline-rate-limits'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { AGENT_COMPACT_COMMAND } from '../../shared/agent-compaction'
import type {
  RuntimeMobileSessionTerminalTab,
  RuntimeTerminalClose,
  RuntimeTerminalFocus,
  RuntimeTerminalSend
} from '../../shared/runtime-types'
import {
  ROOM_HARNESS_AGENTS,
  type RoomAttachment,
  type RoomEvent,
  type RoomExistingAgentCandidate,
  type RoomHarnessAgent,
  type RoomParticipant,
  type RoomProviderSession,
  type RoomRunningAgent
} from '../../shared/rooms'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TuiAgent } from '../../shared/tui-agent'
import { listAiVaultSessions } from '../ai-vault/cached-session-list'
import { isENOENT } from '../ipc/filesystem-auth'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { RoomService } from './rooms/service'
import type { RoomDeletionManifest } from './rooms/database'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import { resolveTerminalSessionWorktreeId } from './runtime-worktree-path-identity'
import { terminalLayoutContainsLeaf } from './headless-terminal-split-layout'
import { waitForWorktreeStartupDraft } from './runtime-worktree-startup-readiness'

export class OrcaRuntimeWithRooms extends OrcaRuntimeWithResolveWaiter {
  private roomService: RoomService | null = null

  getRoomService(): RoomService {
    if (!this.roomService) {
      this.roomService = new RoomService(
        join(getAppEnvironment().getPath('userData'), 'rooms.db'),
        this
      )
    }
    return this.roomService
  }

  setRoomService(service: RoomService): void {
    this.roomService?.close()
    this.roomService = service
  }

  closeRoomService(): void {
    this.roomService?.close()
    this.roomService = null
  }

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

  async listRoomRunningAgents(worktreeId: string): Promise<RoomRunningAgent[]> {
    const listed = await this.listTerminals(`id:${worktreeId}`, 200, {
      requireFreshPtyLiveness: true
    })
    const supported = new Set<string>(ROOM_HARNESS_AGENTS)
    const candidates = await Promise.all(
      listed.terminals.map(async (terminal): Promise<RoomRunningAgent | null> => {
        const status = await this.getTerminalAgentStatus(terminal.handle, {
          confirmForeground: true
        }).catch(() => null)
        const paneKey = this.getTerminalPaneKey(terminal.handle)
        if (!status?.isRunningAgent || !paneKey) {
          return null
        }
        const ptyId = this.getTerminalAgentStatusPtyId(terminal.handle)
        const pty = this.ptysById.get(ptyId)
        const latest = [...(this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? [])].sort(
          (left, right) => right.receivedAt - left.receivedAt
        )[0]
        const agent = pty?.launchAgent ?? pty?.foregroundAgent ?? latest?.agentType
        if (!agent || !supported.has(agent)) {
          return null
        }
        return {
          agent: agent as RoomRunningAgent['agent'],
          worktreeId,
          terminalHandle: terminal.handle,
          paneKey,
          title: terminal.title,
          providerSession: latest?.providerSession ?? null
        }
      })
    )
    return candidates.filter((candidate): candidate is RoomRunningAgent => candidate !== null)
  }

  async listRoomExistingAgents(
    worktreeId: string,
    agent: RoomHarnessAgent
  ): Promise<RoomExistingAgentCandidate[]> {
    const [running, history] = await Promise.all([
      this.listRoomRunningAgents(worktreeId),
      this.listRoomHistoricalSessions(worktreeId, agent)
    ])
    const historyBySession = new Map(
      history.map((session) => [`session_id\0${session.sessionId}`, session])
    )
    const runningSessions = new Set<string>()
    const candidates: RoomExistingAgentCandidate[] = []
    for (const live of running) {
      if (live.agent !== agent) continue
      const providerKey = live.providerSession
        ? `${live.providerSession.key}\0${live.providerSession.id}`
        : null
      if (providerKey && runningSessions.has(providerKey)) continue
      if (providerKey) runningSessions.add(providerKey)
      const session = providerKey ? historyBySession.get(providerKey) : undefined
      if (session) historyBySession.delete(`session_id\0${session.sessionId}`)
      candidates.push({
        id: session?.id ?? `running:${live.terminalHandle}:${live.paneKey}`,
        agent,
        title: live.title ?? session?.title ?? null,
        status: 'running',
        model: session?.model ?? null,
        updatedAt: session?.updatedAt ?? session?.modifiedAt ?? null,
        providerSession: live.providerSession,
        terminalHandle: live.terminalHandle,
        paneKey: live.paneKey,
        ...(session ? { historyId: session.id } : {})
      })
    }
    for (const session of historyBySession.values()) {
      candidates.push({
        id: session.id,
        agent,
        title: session.title,
        status: 'history',
        model: session.model,
        updatedAt: session.updatedAt ?? session.modifiedAt,
        providerSession: {
          key: 'session_id',
          id: session.sessionId,
          transcriptPath: session.filePath
        },
        historyId: session.id
      })
    }
    return candidates
  }

  async resolveRoomHistoricalSession(
    worktreeId: string,
    agent: RoomHarnessAgent,
    historyId: string
  ): Promise<RoomProviderSession> {
    const session = (await this.listRoomHistoricalSessions(worktreeId, agent)).find(
      (candidate) => candidate.id === historyId
    )
    if (!session) {
      throw new Error('room_historical_session_not_found')
    }
    return { key: 'session_id', id: session.sessionId, transcriptPath: session.filePath }
  }

  private async listRoomHistoricalSessions(
    worktreeId: string,
    agent: RoomHarnessAgent
  ): Promise<AiVaultSession[]> {
    const worktree = await this.resolveWorktreeSelector(`id:${worktreeId}`)
    const expectedAgent = agent === 'openclaude' ? 'claude' : agent
    const result = await listAiVaultSessions({ unlimited: true, scopePaths: [worktree.path] })
    return result.sessions.filter(
      (candidate) =>
        candidate.agent === expectedAgent &&
        isAiVaultSessionResumableContent(candidate) &&
        candidate.cwd !== null &&
        isAiVaultSessionInWorkspacePath(worktree.path, candidate.cwd)
    )
  }

  async stageRoomAttachment(
    worktreeId: string,
    terminalHandle: string,
    attachment: Pick<RoomAttachment, 'id' | 'fileName' | 'localPath'>
  ): Promise<string> {
    const ptyId = this.getTerminalAgentStatusPtyId(terminalHandle)
    const pty = this.ptysById.get(ptyId)
    if (!pty || !runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId)) {
      throw new Error('terminal_handle_stale')
    }
    const extension = extname(attachment.fileName)
      .slice(0, 20)
      .replace(/[^.\p{L}\p{N}_-]/gu, '_')
    const stableId = attachment.id.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 160)
    if (!stableId) {
      throw new Error('room_attachment_id_invalid')
    }
    if (!pty.connectionId) {
      return pty.wslDistro
        ? this.toWslRoomAttachmentPath(pty.wslDistro, attachment.localPath)
        : attachment.localPath
    }
    const worktree = await this.resolveWorktreeSelector(`id:${worktreeId}`)
    const pathApi = isWindowsAbsolutePathLike(worktree.path) ? win32 : posix
    const orcaDirectory = pathApi.join(worktree.path, '.orca')
    const directory = pathApi.join(orcaDirectory, 'drops')
    const filePath = pathApi.join(directory, `${stableId}${extension}`)
    const provider = getSshFilesystemProvider(pty.connectionId)
    if (!provider) {
      throw new Error('room_attachment_remote_unavailable')
    }
    await provider.createDir(orcaDirectory)
    const gitignorePath = pathApi.join(orcaDirectory, '.gitignore')
    try {
      await provider.stat(gitignorePath)
    } catch (error) {
      if (!isENOENT(error)) throw error
      await provider.writeFile(gitignorePath, '*\n!.gitignore\n')
    }
    await provider.createDir(directory)
    try {
      await provider.stat(filePath)
      this.roomService?.recordAttachmentDrop(attachment.id, pty.connectionId, filePath)
      return filePath
    } catch (error) {
      if (!isENOENT(error)) throw error
    }
    if (!provider.openFileUploadSession) {
      throw new Error('room_attachment_remote_unavailable')
    }
    const upload = await provider.openFileUploadSession()
    try {
      await upload.uploadFile(attachment.localPath, filePath, { exclusive: true })
      this.roomService?.recordAttachmentDrop(attachment.id, pty.connectionId, filePath)
      return filePath
    } catch (error) {
      try {
        await provider.stat(filePath)
        this.roomService?.recordAttachmentDrop(attachment.id, pty.connectionId, filePath)
        return filePath
      } catch {
        throw error
      }
    } finally {
      upload.close()
    }
  }

  async cleanupDeletedRoomResources(manifest: RoomDeletionManifest): Promise<void> {
    await Promise.all(
      manifest.drops.map(async ({ connectionId, remotePath }) => {
        const provider = getSshFilesystemProvider(connectionId)
        if (!provider) throw new Error('room_attachment_remote_unavailable')
        try {
          await provider.deletePath(remotePath)
        } catch (error) {
          if (!isENOENT(error)) throw error
        }
      })
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
    return this.roomService?.participantForTerminal(handle) !== null
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
    return super.getTerminalPaneKey(handle) ?? this.roomService?.participantForTerminal(handle)?.paneKey ?? null
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

  private toWslRoomAttachmentPath(distro: string, localPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'wsl.exe',
        ['-d', distro, '--', 'wslpath', '-a', '-u', localPath],
        { timeout: 10_000, windowsHide: true },
        (error, stdout) => {
          const converted = stdout.trim()
          if (error || !converted) reject(error ?? new Error('room_attachment_wsl_path_invalid'))
          else resolve(converted)
        }
      )
    })
  }
}
