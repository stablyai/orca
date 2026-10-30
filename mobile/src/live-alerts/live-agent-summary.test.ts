import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  collectLiveAgents,
  lastFinishedAgent,
  livePhaseForDot,
  primaryLiveAgent
} from './live-agent-summary'

const NOW = 1_000_000_000
const FAILED = {
  mainAgent: { state: 'done' as const, outcome: 'failure' as const, stateStartedAt: NOW }
}

function row(overrides: Partial<RuntimeWorktreeAgentRow> = {}): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'tab-1:leaf-1',
    parentPaneKey: null,
    state: 'working',
    agentType: 'opencode',
    prompt: '',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function worktree(agents: RuntimeWorktreeAgentRow[], extra: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId: 'wt-1',
    repoId: 'repo-1',
    repo: 'demo-repo',
    branch: 'main',
    displayName: 'demo-repo',
    path: '/repo',
    liveTerminalCount: 1,
    hasAttachedPty: true,
    unread: false,
    isPinned: false,
    linkedPR: null,
    agents,
    ...extra
  }
}

function collect(...worktrees: Worktree[]) {
  return collectLiveAgents([{ hostId: 'host-1', hostName: 'Desk', worktrees }], NOW)
}

describe('collectLiveAgents', () => {
  it('maps desktop states to notification phases', () => {
    const agents = collect(
      worktree([
        row({ paneKey: 'a:1', state: 'working' }),
        row({ paneKey: 'b:1', state: 'waiting', toolName: 'external_directory' }),
        row({ paneKey: 'c:1', state: 'blocked' }),
        row({ paneKey: 'd:1', state: 'waiting', toolName: 'AskUserQuestion' }),
        row({ paneKey: 'e:1', state: 'done' }),
        row({ paneKey: 'f:1', state: 'done', interrupted: true }),
        row({ paneKey: 'g:1', state: 'done', ...FAILED })
      ])
    )
    expect(agents.map((agent) => [agent.paneKey, agent.phase, agent.need])).toEqual([
      ['a:1', 'working', null],
      ['b:1', 'waiting', 'approval'],
      ['c:1', 'waiting', 'input'],
      ['d:1', 'waiting', 'input'],
      ['e:1', 'done', null],
      ['f:1', 'stopped', null],
      ['g:1', 'failed', null]
    ])
  })

  it('leaves out monitoring, stale and archived agents', () => {
    const staleAt = NOW - 31 * 60 * 1000
    const agents = collect(
      worktree([
        row({ paneKey: 'a:1', workingMode: 'monitoring' }),
        row({ paneKey: 'b:1', updatedAt: staleAt })
      ]),
      worktree([row({ paneKey: 'c:1' })], { worktreeId: 'wt-2', isArchived: true })
    )
    expect(agents).toEqual([])
  })

  it('names the workspace and keeps the runtime server for taps', () => {
    const [local] = collect(worktree([row()], { displayName: '', branch: 'feature/x' }))
    expect(local.workspace).toBe('feature/x')
    expect(local.executionHost).toBeNull()
    expect(local.key).toBe(JSON.stringify(['host-1', 'tab-1:leaf-1']))
    const [remote] = collect(worktree([row()], { hostId: 'runtime:server-1' }))
    expect(remote.executionHost).toBe('runtime:server-1')
    const [ssh] = collect(worktree([row()], { hostId: 'ssh:box' }))
    expect(ssh.executionHost).toBeNull()
  })
})

describe('agent selection', () => {
  it('leads with the longest-waiting agent, else the latest worker', () => {
    const agents = collect(
      worktree([
        row({ paneKey: 'a:1', updatedAt: NOW - 5 }),
        row({ paneKey: 'b:1', updatedAt: NOW - 1 }),
        row({ paneKey: 'c:1', state: 'waiting', stateStartedAt: NOW - 3 }),
        row({ paneKey: 'd:1', state: 'waiting', stateStartedAt: NOW - 9 })
      ])
    )
    expect(primaryLiveAgent(agents)?.paneKey).toBe('d:1')
    const working = agents.filter((agent) => agent.phase === 'working')
    expect(primaryLiveAgent(working)?.paneKey).toBe('b:1')
    expect(lastFinishedAgent(agents)).toBeNull()
  })

  it('picks the agent that finished last', () => {
    const agents = collect(
      worktree([
        row({ paneKey: 'a:1', state: 'done', stateStartedAt: NOW - 2 }),
        row({ paneKey: 'b:1', state: 'done', stateStartedAt: NOW - 1 }),
        row({ paneKey: 'c:1', state: 'working' })
      ])
    )
    expect(lastFinishedAgent(agents)?.paneKey).toBe('b:1')
    expect(primaryLiveAgent(agents)?.paneKey).toBe('c:1')
  })
})

describe('livePhaseForDot', () => {
  it('leaves out an agent with no recent update', () => {
    expect(livePhaseForDot('unverifiable')).toBeNull()
    expect(livePhaseForDot('working')).toBe('working')
  })
})
