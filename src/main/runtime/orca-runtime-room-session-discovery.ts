import { isAiVaultSessionInWorkspacePath } from '../../shared/ai-vault-session-filters'
import { isAiVaultSessionResumableContent, type AiVaultSession } from '../../shared/ai-vault-types'
import {
  ROOM_HARNESS_AGENTS,
  type RoomExistingAgentCandidate,
  type RoomHarnessAgent,
  type RoomProviderSession,
  type RoomRunningAgent
} from '../../shared/rooms'
import { projectStructuredAgentSessionStatus } from '../../shared/structured-agent-session-projection'
import { listAiVaultSessions } from '../ai-vault/cached-session-list'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'

export class OrcaRuntimeWithRoomSessionDiscovery extends OrcaRuntimeWithResolveWaiter {
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
    agent: RoomHarnessAgent,
    machineStreaming = false
  ): Promise<RoomExistingAgentCandidate[]> {
    if (machineStreaming) {
      await this.ensureStructuredAgentSessionHost()
    }
    const [running, history] = await Promise.all([
      this.listRoomRunningAgents(worktreeId),
      this.listRoomHistoricalSessions(worktreeId, agent)
    ])
    const historyBySession = new Map(
      history.map((session) => [`session_id\0${session.sessionId}`, session])
    )
    const runningSessions = new Set<string>()
    const candidates: RoomExistingAgentCandidate[] = []
    const host = machineStreaming ? getStructuredAgentSessionHost() : null
    for (const session of host?.listSessionTabs() ?? []) {
      if (session.workspaceId !== worktreeId || session.agent !== agent) {
        continue
      }
      const result = host!.history({ sessionId: session.sessionId, direction: 'tail', limit: 200 })
      const sourceSessionId = result.providerSession?.id
      const sourceKey = sourceSessionId ? `session_id\0${sourceSessionId}` : null
      if (sourceKey) {
        runningSessions.add(sourceKey)
        historyBySession.delete(sourceKey)
      }
      const firstUserMessage = result.page.items.find(
        (item) => item.body.kind === 'message' && item.body.role === 'user'
      )
      const title =
        firstUserMessage?.body.kind === 'message'
          ? firstUserMessage.body.blocks.find((block) => block.type === 'text')?.text
          : undefined
      candidates.push({
        id: `conversation:${session.sessionId}`,
        agent,
        title: title?.slice(0, 120) ?? null,
        status:
          projectStructuredAgentSessionStatus(result.page.items) === 'working'
            ? 'running'
            : 'history',
        model: null,
        updatedAt: result.page.items.at(-1)?.observedAt
          ? new Date(result.page.items.at(-1)!.observedAt).toISOString()
          : null,
        providerSession: {
          key: 'session_id',
          id: session.sessionId,
          transport: 'machine',
          ...(sourceSessionId ? { sourceSessionId } : {})
        },
        conversationId: session.sessionId
      })
    }
    for (const live of running) {
      if (live.agent !== agent) {
        continue
      }
      const providerKey = live.providerSession
        ? `${live.providerSession.key}\0${live.providerSession.id}`
        : null
      if (providerKey && runningSessions.has(providerKey)) {
        continue
      }
      if (providerKey) {
        runningSessions.add(providerKey)
      }
      const session = providerKey ? historyBySession.get(providerKey) : undefined
      if (session) {
        historyBySession.delete(`session_id\0${session.sessionId}`)
      }
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
}
