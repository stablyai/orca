import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { HostWorktreeInfo } from '../worktree/home-worktree-info'
import type { AgentListInput } from './agent-list-rows'
import { matchAgentlessWorkspaces } from './agent-list-workspace-matches'

const workspace = (worktreeId: string, workspaceName: string, branch = 'main') => ({
  worktreeId,
  workspaceName,
  repo: 'orca',
  branch
})

function input(info: Partial<HostWorktreeInfo>, connected = true): AgentListInput {
  return {
    hosts: [{ id: 'h1' }],
    hostStates: { h1: connected ? 'connected' : 'disconnected' },
    worktreeInfo: {
      h1: { hostId: 'h1', totalWorktrees: 0, activeCount: 0, lastActiveWorktree: null, ...info }
    },
    now: 0
  }
}

describe('matchAgentlessWorkspaces', () => {
  const workspaces = [
    workspace('w1', 'search-box', 'feat/search'),
    workspace('w2', 'docs'),
    workspace('w3', 'busy', 'feat/search')
  ]
  const agent: RuntimeWorktreeAgentRow = {
    paneKey: 'p1',
    parentPaneKey: null,
    state: 'working',
    agentType: 'claude',
    prompt: '',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 0,
    updatedAt: 0
  }
  const agents = [
    { worktreeId: 'w3', workspaceName: 'busy', repo: 'orca', branch: 'feat/search', agent }
  ]

  it('finds workspaces with no agent by every typed word, leaving ones with agents to their rows', () => {
    const matches = matchAgentlessWorkspaces(input({ workspaces, agents }), {
      hostFilter: null,
      query: 'orca search'
    })
    expect(matches.map((match) => match.workspace.worktreeId)).toEqual(['w1'])
  })

  it('lists nothing without a query or from a desktop that is not connected', () => {
    expect(
      matchAgentlessWorkspaces(input({ workspaces }), { hostFilter: null, query: ' ' })
    ).toEqual([])
    expect(
      matchAgentlessWorkspaces(input({ workspaces }, false), { hostFilter: null, query: 'docs' })
    ).toEqual([])
  })
})
