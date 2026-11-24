import { describe, expect, it } from 'vitest'
import type { AgentListStatus } from '../../../src/shared/agent-status/presentation/agent-list-status'
import type { HomeAgentEntry } from '../worktree/catalog/home-worktree-info'
import { commanderProjects } from './commander-projects'

function agent(
  id: string,
  repoId: string,
  status: AgentListStatus,
  parent?: string
): HomeAgentEntry {
  return {
    worktreeId: repoId + '::/checkout',
    workspaceName: 'checkout',
    repo: 'app',
    branch: 'main',
    agent: {
      paneKey: id,
      parentPaneKey: parent ?? null,
      state: 'working',
      agentType: null,
      prompt: '',
      taskTitle: null,
      displayName: id,
      lastAssistantMessage: null,
      toolName: null,
      toolInput: null,
      interrupted: false,
      stateStartedAt: 1,
      updatedAt: 1,
      activity: {
        listed: true,
        status,
        title: id,
        unread: false,
        clearable: false,
        sortAt: 1,
        childOf: parent
      }
    }
  }
}

describe('Commander project overview', () => {
  it('keeps nested workers in their own project and surfaces waiting work across hundreds of agents', () => {
    const entries = Array.from({ length: 299 }, (_, i) =>
      agent('worker' + i, 'workers', 'working', 'root')
    )
    const results = commanderProjects({
      hosts: [{ id: 'a' }, { id: 'b' }],
      hostStates: { a: 'connected', b: 'disconnected' },
      now: 1,
      worktreeInfo: {
        a: {
          hostId: 'a',
          activeCount: 1,
          totalWorktrees: 3,
          projects: [{ repo: 'quiet', worktreeId: 'empty::/x' }],
          agents: [agent('root', 'parent', 'waiting'), ...entries]
        },
        b: {
          hostId: 'b',
          activeCount: 1,
          totalWorktrees: 1,
          lastSeenAgents: [agent('root', 'parent', 'blocked')]
        }
      }
    })
    expect(results.map((p) => p.rows.length)).toEqual([1, 299, 0, 1])
    expect(new Set(results.map((p) => p.key)).size).toBe(4)
    expect(results[0].counts['needs-you']).toBe(1)
    expect(results[1].counts.working).toBe(299)
    expect(results[3].counts['last-seen']).toBe(1)
    expect(results[3].counts['needs-you']).toBe(0)
  })
  it('includes registered projects without a checkout and separates identical IDs on other execution hosts', () => {
    const projects = commanderProjects(
      {
        hosts: [{ id: 'a' }],
        hostStates: { a: 'connected' },
        now: 1,
        worktreeInfo: { a: { hostId: 'a', totalWorktrees: 0, activeCount: 0, agents: [] } }
      },
      [
        { hostId: 'a', repoId: 'app', name: 'local project', executionHostId: 'local' },
        { hostId: 'a', repoId: 'app', name: 'remote project', executionHostId: 'runtime:server' }
      ]
    )
    expect(projects.map((p) => [p.name, p.live, p.rows.length])).toEqual([
      ['local project', true, 0],
      ['remote project', false, 0]
    ])
  })
  it('keeps interrupted and unverifiable sessions out of completed totals', () => {
    const [project] = commanderProjects({
      hosts: [{ id: 'a' }],
      hostStates: { a: 'connected' },
      now: 1,
      worktreeInfo: {
        a: {
          hostId: 'a',
          activeCount: 1,
          totalWorktrees: 1,
          agents: [
            agent('old', 'app', 'unverifiable'),
            agent('stop', 'app', 'interrupted'),
            agent('end', 'app', 'done')
          ]
        }
      }
    })
    expect(project.counts).toMatchObject({ done: 1, interrupted: 1, 'last-seen': 1 })
  })
})
