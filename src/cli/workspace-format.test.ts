import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../shared/agent-status-freshness'
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary
} from '../shared/runtime-types'
import { withWorktreePsDisplayStatus } from './agent-display-state'
import { WORKTREE_HANDLERS } from './handlers/worktree'
import { formatCommandHelp } from './help'
import { CORE_COMMAND_SPECS } from './specs/core'
import { formatWorktreePs } from './workspace-format'

const NOW = 10 * AGENT_STATUS_STALE_AFTER_MS

function agent(overrides: Partial<RuntimeWorktreeAgentRow> = {}): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'tab-1:leaf-1',
    parentPaneKey: null,
    state: 'working',
    agentType: 'claude',
    prompt: 'fix it',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: NOW - 10,
    updatedAt: NOW - 10,
    ...overrides
  }
}

function worktree(overrides: Partial<RuntimeWorktreePsSummary> = {}): RuntimeWorktreePsSummary {
  return {
    worktreeId: 'repo::/wt',
    repoId: 'repo',
    hostId: 'local',
    repo: 'orca',
    path: '/wt',
    branch: 'feature',
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: true,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: 'feature',
    workspaceStatus: 'in-progress',
    sortOrder: 0,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    lastOutputAt: null,
    preview: '',
    status: 'working',
    agents: [],
    ...overrides
  }
}

function result(worktrees: RuntimeWorktreePsSummary[]): RuntimeWorktreePsResult {
  return { worktrees, totalCount: worktrees.length, truncated: false }
}

const failedMainAgent = { state: 'done' as const, outcome: 'failure' as const, stateStartedAt: 1 }

describe('worktree ps display status', () => {
  it('prints status:failed when the main turn failed under a host working rollup', () => {
    const printed = formatWorktreePs(
      withWorktreePsDisplayStatus(
        result([worktree({ agents: [agent({ state: 'working', mainAgent: failedMainAgent })] })]),
        NOW
      )
    )

    expect(printed).toContain('orca feature  host=local  status:failed  live:1')
  })

  it('keeps the host permission rollup above a failed turn', () => {
    const annotated = withWorktreePsDisplayStatus(
      result([
        worktree({
          status: 'permission',
          agents: [agent({ state: 'done', mainAgent: failedMainAgent })]
        })
      ]),
      NOW
    )

    expect(annotated.worktrees[0]?.displayStatus).toBe('permission')
  })

  it('shows a stale failure but decays a stale live row', () => {
    const stale = NOW - AGENT_STATUS_STALE_AFTER_MS - 1
    const annotated = withWorktreePsDisplayStatus(
      result([
        worktree({
          status: 'active',
          agents: [
            agent({ paneKey: 'a', state: 'waiting', updatedAt: stale }),
            agent({ paneKey: 'b', state: 'working', mainAgent: failedMainAgent, updatedAt: stale })
          ]
        })
      ]),
      NOW
    )

    expect(annotated.worktrees[0]?.agents.map((row) => row.displayState)).toEqual([
      'idle',
      'failed'
    ])
    expect(annotated.worktrees[0]?.displayStatus).toBe('failed')
  })

  it('prints the host rollup unchanged for rows without a main agent record', () => {
    const annotated = withWorktreePsDisplayStatus(
      result([worktree({ status: 'done', agents: [agent({ state: 'done', interrupted: true })] })]),
      NOW
    )

    expect(annotated.worktrees[0]?.displayStatus).toBe('done')
    expect(annotated.worktrees[0]?.agents[0]?.displayState).toBe('interrupted')
    expect(formatWorktreePs(annotated)).toContain('status:done')
  })

  it('degrades a main agent state this build does not know to the row state', () => {
    const annotated = withWorktreePsDisplayStatus(
      result([
        worktree({
          agents: [
            agent({
              state: 'working',
              // A newer host's state arm.
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: models a wire value this build's type cannot name.
              mainAgent: { state: 'paused', stateStartedAt: 1 } as never
            })
          ]
        })
      ]),
      NOW
    )

    expect(annotated.worktrees[0]?.agents[0]?.displayState).toBe('working')
  })
})

describe('worktree ps --json', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds displayStatus and displayState beside the host status it leaves untouched', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn().mockResolvedValue({
      id: 'req',
      ok: true,
      result: result([
        worktree({
          status: 'working',
          agents: [
            agent({
              state: 'working',
              mainAgent: failedMainAgent,
              updatedAt: Date.now()
            })
          ]
        })
      ]),
      _meta: { runtimeId: 'runtime-1' }
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `worktree ps` reads only `flags`, `client.call` and `json`; RuntimeClient is a class a structural double cannot satisfy.
    await WORKTREE_HANDLERS['worktree ps']({
      flags: new Map(),
      client: { call },
      cwd: '/tmp/repo',
      json: true
    } as never)

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.result.worktrees[0]).toMatchObject({
      status: 'working',
      displayStatus: 'failed',
      agents: [{ state: 'working', displayState: 'failed' }]
    })
  })

  it('names status as the host lifecycle rollup and displayStatus as presentation in help', () => {
    const spec = CORE_COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'worktree ps')
    const help = spec ? formatCommandHelp(spec) : ''

    expect(help).toContain(
      "`status` is the host's lifecycle rollup, kept stable for older clients."
    )
    expect(help).toContain('`displayStatus` / `displayState` are what Orca shows')
    expect(help).toContain('Do not treat them as synonyms.')
  })
})
