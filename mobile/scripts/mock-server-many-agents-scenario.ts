import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary
} from '../../src/shared/worktree/catalog/runtime-worktree-contracts'
import type { RpcRequest, RpcResponse } from './mock-server-rpc-handlers'

type Respond = (response: RpcResponse) => void
type Success = (id: string, result: unknown, streaming?: boolean) => RpcResponse

const REPO_PATH = '/tmp/orca-mobile-repro/orca'
const WORKTREE_PATH = `${REPO_PATH}/worktrees/agent-carousel`
const WORKTREE_ID = `repo-1::${WORKTREE_PATH}`

type MockAgent = {
  agentType: string
  state: RuntimeWorktreeAgentRow['state']
  prompt: string
  lastMessage: string | null
  toolName: string | null
  toolInput: string | null
  /** Not on the row contract yet; sent as an extra wire field so a renderer that learns it can show it. */
  model?: string
  minutesAgo: number
}

// Six live agents of mixed providers and states in one workspace, for the sidebar agent list.
const AGENTS: MockAgent[] = [
  {
    agentType: 'claude',
    state: 'working',
    prompt: 'Plan the sidebar card',
    lastMessage: 'Sketching the collapsed and expanded card states.',
    toolName: 'Read',
    toolInput: 'src/renderer/sidebar/WorktreeCard.tsx',
    model: 'claude-opus-5-5',
    minutesAgo: 1
  },
  {
    agentType: 'codex',
    state: 'working',
    prompt: 'Run the web typecheck',
    lastMessage: 'Running pnpm typecheck:web.',
    toolName: 'shell',
    toolInput: 'pnpm typecheck:web',
    model: 'gpt-5.5-codex',
    minutesAgo: 3
  },
  {
    agentType: 'droid',
    state: 'blocked',
    prompt: 'Fix flaky terminal test',
    lastMessage: 'Needs approval to rerun the suite with --repeat 50.',
    toolName: null,
    toolInput: null,
    minutesAgo: 6
  },
  {
    agentType: 'cursor',
    state: 'done',
    prompt: 'Draft the release notes',
    lastMessage: 'Release notes drafted in docs/release-notes.md.',
    toolName: null,
    toolInput: null,
    minutesAgo: 12
  },
  {
    agentType: 'opencode',
    state: 'working',
    prompt: 'Bump Electron',
    lastMessage: 'Updating electron to the next major and rebuilding natives.',
    toolName: 'bash',
    toolInput: 'pnpm up electron',
    minutesAgo: 2
  },
  {
    agentType: 'claude',
    state: 'done',
    prompt: 'Review the plugin manifest',
    lastMessage: 'Manifest looks good; two optional fields flagged.',
    toolName: null,
    toolInput: null,
    model: 'claude-opus-5-5',
    minutesAgo: 20
  }
]

function agentRow(agent: MockAgent, index: number, now: number): RuntimeWorktreeAgentRow {
  const at = now - agent.minutesAgo * 60_000
  const row: RuntimeWorktreeAgentRow & { model?: string } = {
    paneKey: `tab-many-agents-${index}:pane-1`,
    parentPaneKey: null,
    state: agent.state,
    agentType: agent.agentType,
    prompt: agent.prompt,
    taskTitle: null,
    displayName: null,
    conversationName: agent.prompt,
    lastAssistantMessage: agent.lastMessage,
    toolName: agent.toolName,
    toolInput: agent.toolInput,
    interrupted: false,
    stateStartedAt: at,
    updatedAt: at,
    hasLivePty: true,
    ...(agent.model ? { model: agent.model } : {})
  }
  return row
}

function worktrees(): RuntimeWorktreePsSummary[] {
  const now = Date.now()
  return [
    {
      worktreeId: WORKTREE_ID,
      repoId: 'repo-1',
      repo: 'orca',
      path: WORKTREE_PATH,
      branch: 'feat/sidebar-agent-carousel',
      isArchived: false,
      isMainWorktree: false,
      hasHostSidebarActivity: true,
      parentWorktreeId: null,
      childWorktreeIds: [],
      displayName: 'agent-carousel',
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
      liveTerminalCount: AGENTS.length,
      hasAttachedPty: true,
      lastOutputAt: now,
      preview: '',
      status: 'active',
      agents: AGENTS.map((agent, index) => agentRow(agent, index, now))
    }
  ]
}

// Opt-in MOCK_MANY_AGENTS=1: one workspace running six agents (claude, codex, droid, cursor,
// opencode, claude) across working / blocked / done, for the workspace row's agent list.
export function handleMockManyAgentsRequest(
  request: RpcRequest,
  respond: Respond,
  success: Success
): boolean {
  if (process.env.MOCK_MANY_AGENTS !== '1') {
    return false
  }
  switch (request.method) {
    case 'worktree.ps':
      respond(success(request.id, { worktrees: worktrees(), totalCount: 1, truncated: false }))
      return true
    default:
      return false
  }
}
