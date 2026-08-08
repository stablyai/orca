import { execFile } from 'node:child_process'
import { extname, join, posix, win32 } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { isAiVaultSessionInWorkspacePath } from '../../shared/ai-vault-session-filters'
import { isAiVaultSessionResumableContent } from '../../shared/ai-vault-types'
import type { ClaudeStatusLineRateLimits } from '../../shared/claude-statusline-rate-limits'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { AGENT_COMPACT_COMMAND } from '../../shared/agent-compaction'
import type { RuntimeTerminalClose, RuntimeTerminalSend } from '../../shared/runtime-types'
import {
  ROOM_HARNESS_AGENTS,
  type RoomAttachableAgent,
  type RoomAttachment,
  type RoomEvent,
  type RoomHarnessAgent,
  type RoomProviderSession
} from '../../shared/rooms'
import type { TuiAgent } from '../../shared/tui-agent'
import { listAiVaultSessions } from '../ai-vault/cached-session-list'
import { isENOENT } from '../ipc/filesystem-auth'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { RoomService } from './rooms/service'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
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

  shouldPublishAgentStatusToRenderer(): boolean {
    return true
  }

  override getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined {
    return (
      super.getAgentStatusTerminalHandleForPaneKey(paneKey) ??
      this.roomService?.participantForPane(paneKey)?.terminalHandle ??
      undefined
    )
  }

  async listRoomAttachableAgents(worktreeId: string): Promise<RoomAttachableAgent[]> {
    const listed = await this.listTerminals(`id:${worktreeId}`, 200, {
      requireFreshPtyLiveness: true
    })
    const supported = new Set<string>(ROOM_HARNESS_AGENTS)
    const candidates = await Promise.all(
      listed.terminals.map(async (terminal): Promise<RoomAttachableAgent | null> => {
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
          agent: agent as RoomAttachableAgent['agent'],
          worktreeId,
          terminalHandle: terminal.handle,
          paneKey,
          title: terminal.title,
          providerSession: latest?.providerSession ?? null
        }
      })
    )
    return candidates.filter((candidate): candidate is RoomAttachableAgent => candidate !== null)
  }

  async resolveRoomHistoricalSession(
    worktreeId: string,
    agent: RoomHarnessAgent,
    historyId: string
  ): Promise<RoomProviderSession> {
    const worktree = await this.resolveWorktreeSelector(`id:${worktreeId}`)
    const expectedAgent = agent === 'openclaude' ? 'claude' : agent
    const result = await listAiVaultSessions({ unlimited: true, scopePaths: [worktree.path] })
    const session = result.sessions.find(
      (candidate) =>
        candidate.id === historyId &&
        candidate.agent === expectedAgent &&
        isAiVaultSessionResumableContent(candidate) &&
        candidate.cwd !== null &&
        isAiVaultSessionInWorkspacePath(worktree.path, candidate.cwd)
    )
    if (!session) {
      throw new Error('room_historical_session_not_found')
    }
    return { key: 'session_id', id: session.sessionId, transcriptPath: session.filePath }
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
      return filePath
    } catch (error) {
      try {
        await provider.stat(filePath)
        return filePath
      } catch {
        throw error
      }
    } finally {
      upload.close()
    }
  }

  publishRoomAgentProviderSession(
    handle: string,
    agent: string,
    providerSession: AgentProviderSessionMetadata
  ): void {
    const paneKey = this.getTerminalPaneKey(handle)
    const pty = this.getLivePtyForHandle(handle)
    if (!paneKey || !pty || !this.onTerminalAgentStatus) {
      return
    }
    const rows = this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? []
    const known = rows.find((row) => row.providerSession?.id === providerSession.id)
    if (known?.providerSession?.transcriptPath === providerSession.transcriptPath) {
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

  override async closeTerminal(
    handle: string,
    options?: { force?: boolean }
  ): Promise<RuntimeTerminalClose> {
    const live = this.getLivePtyForHandle(handle)
    if (!options?.force && live && this.roomService?.participantForTerminal(handle)) {
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
