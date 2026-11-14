import { structuredAgentSessionTabId } from '../../src/shared/agent-session/view/structured-agent-session-projection'
import {
  DESKTOP_PROTOCOL_VERSION,
  MIN_COMPATIBLE_MOBILE_VERSION
} from '../../src/shared/protocol-version'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary
} from '../../src/shared/runtime-types'
import type { RpcRequest, RpcResponse } from './mock-server-rpc-handlers'

type Respond = (response: RpcResponse) => void
type Success = (id: string, result: unknown, streaming?: boolean) => RpcResponse

const REPO_PATH = '/tmp/orca-mobile-repro/orca'
const WORKTREE_PATH = `${REPO_PATH}/worktrees/forks`
const WORKTREE_ID = `repo-1::${WORKTREE_PATH}`

type MockChat = {
  sessionId: string
  /** The saved name; null leaves the agent's default label. */
  name: string | null
  /** What the host shows: an older fork's appended " fork" already dropped. */
  shownName: string
  forkedFrom: { sessionId: string; plainName?: true } | null
  lastMessage: string
}

// An original, its fork, a fork of that fork, an unnamed fork, and an older-build fork.
const CHATS: MockChat[] = [
  {
    sessionId: 'chat-original',
    name: 'Annotate capabilities',
    shownName: 'Annotate capabilities',
    forkedFrom: null,
    lastMessage: 'Listed every capability with its owner.'
  },
  {
    sessionId: 'chat-fork',
    name: 'Annotate capabilities',
    shownName: 'Annotate capabilities',
    forkedFrom: { sessionId: 'chat-original', plainName: true },
    lastMessage: 'Trying the table layout instead.'
  },
  {
    sessionId: 'chat-fork-of-fork',
    name: 'Annotate capabilities',
    shownName: 'Annotate capabilities',
    forkedFrom: { sessionId: 'chat-fork', plainName: true },
    lastMessage: 'Grouped the table by owner.'
  },
  {
    sessionId: 'chat-unnamed-fork',
    name: null,
    shownName: 'Claude Chat',
    forkedFrom: { sessionId: 'chat-original', plainName: true },
    lastMessage: 'Started from the capability list.'
  },
  {
    sessionId: 'chat-legacy-fork',
    name: 'Plan the migration fork',
    shownName: 'Plan the migration',
    forkedFrom: { sessionId: 'chat-plan' },
    lastMessage: 'Drafted the rollback steps.'
  },
  {
    sessionId: 'chat-plan',
    name: 'Plan the migration',
    shownName: 'Plan the migration',
    forkedFrom: null,
    lastMessage: 'Outlined the three phases.'
  }
]

const tabId = (chat: MockChat): string => structuredAgentSessionTabId(chat.sessionId)

function tabsResult(): RuntimeMobileSessionTabsResult {
  const tabs = CHATS.slice(0, 4).map((chat) => ({
    type: 'agent-session' as const,
    id: tabId(chat),
    title: chat.shownName,
    sessionId: chat.sessionId,
    agent: 'claude' as const,
    ...(chat.forkedFrom ? { forked: true as const } : {}),
    isActive: chat.sessionId === 'chat-fork'
  }))
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'mock-forked-chats',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: tabId(CHATS[1]!),
    activeTabType: 'agent-session',
    tabGroups: [
      { id: 'group-1', activeTabId: tabId(CHATS[1]!), tabOrder: tabs.map((tab) => tab.id) }
    ],
    tabs
  }
}

function agentRow(chat: MockChat, index: number, now: number): RuntimeWorktreeAgentRow {
  return {
    paneKey: `${tabId(chat)}:chat`,
    parentPaneKey: null,
    state: index === 1 ? 'working' : 'done',
    agentType: 'claude',
    prompt: chat.shownName,
    taskTitle: null,
    displayName: null,
    conversationName: chat.shownName,
    ...(chat.forkedFrom ? { conversationForked: true as const } : {}),
    lastAssistantMessage: chat.lastMessage,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: now - index * 60_000,
    updatedAt: now - index * 60_000
  }
}

function worktrees(): RuntimeWorktreePsSummary[] {
  const now = Date.now()
  return [
    {
      worktreeId: WORKTREE_ID,
      repoId: 'repo-1',
      repo: 'orca',
      path: WORKTREE_PATH,
      branch: 'feature/forks',
      isArchived: false,
      isMainWorktree: false,
      hasHostSidebarActivity: true,
      parentWorktreeId: null,
      childWorktreeIds: [],
      displayName: 'forks',
      workspaceStatus: 'in-progress',
      sortOrder: now,
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      comment: '',
      isPinned: false,
      isActive: true,
      unread: false,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      lastOutputAt: now,
      preview: '',
      status: 'active',
      agents: CHATS.slice(0, 4).map((chat, index) => agentRow(chat, index, now))
    }
  ]
}

function historySession(chat: MockChat, index: number) {
  const at = new Date(Date.now() - index * 3_600_000).toISOString()
  return {
    id: `claude:${chat.sessionId}`,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: chat.sessionId,
    // Vault rows carry the transcript's own title; the naming feed supplies the saved name.
    title: chat.name ?? 'Claude Chat',
    cwd: WORKTREE_PATH,
    branch: 'feature/forks',
    model: null,
    filePath: `/tmp/orca-mobile-repro/transcripts/${chat.sessionId}.jsonl`,
    codexHome: null,
    createdAt: at,
    updatedAt: at,
    modifiedAt: at,
    messageCount: 4,
    totalTokens: 1200,
    previewMessages: [
      { role: 'user', text: 'Keep going.', timestamp: at },
      { role: 'assistant', text: chat.lastMessage, timestamp: at }
    ],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    structuredSession: { sessionId: chat.sessionId, workspaceId: WORKTREE_ID }
  }
}

// Opt-in MOCK_FORKED_CHATS=1: one workspace whose chats include forks, a fork of a fork, an
// unnamed fork and an older-build fork, for the fork mark on tabs, rows and history.
export function handleMockForkedChatsRequest(
  request: RpcRequest,
  respond: Respond,
  success: Success
): boolean {
  if (process.env.MOCK_FORKED_CHATS !== '1') {
    return false
  }
  switch (request.method) {
    case 'status.get':
      respond(
        success(request.id, {
          runtimeId: 'mock-runtime',
          protocolVersion: DESKTOP_PROTOCOL_VERSION,
          minCompatibleMobileVersion: MIN_COMPATIBLE_MOBILE_VERSION,
          capabilities: ['aiVault.v1'],
          graphStatus: 'ready',
          windowCount: 1,
          tabCount: 4,
          terminalCount: 0
        })
      )
      return true
    case 'worktree.ps':
      respond(success(request.id, { worktrees: worktrees(), totalCount: 1, truncated: false }))
      return true
    case 'session.tabs.list':
      respond(success(request.id, tabsResult()))
      return true
    case 'session.tabs.subscribe':
      respond(success(request.id, { type: 'snapshot', ...tabsResult() }, true))
      respond(success(request.id, { type: 'updated', ...tabsResult() }, true))
      return true
    case 'session.tabs.unsubscribe':
      respond(success(request.id, { unsubscribed: true }))
      return true
    case 'aiVault.listSessions':
      respond(
        success(request.id, {
          sessions: CHATS.map((chat, i) => historySession(chat, i)),
          issues: []
        })
      )
      return true
    case 'agentSession.subscribeStatus':
      respond(
        success(
          request.id,
          {
            type: 'snapshot',
            sessions: [],
            namingActiveSessionIds: [],
            conversationNames: CHATS.map((chat) => ({
              sessionId: chat.sessionId,
              conversationName: chat.name,
              forkedFrom: chat.forkedFrom
            }))
          },
          true
        )
      )
      return true
    default:
      return false
  }
}
