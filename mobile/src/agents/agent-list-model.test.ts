import { describe, expect, it } from 'vitest'
import type { AgentListStatus } from '../../../src/shared/agent-status/presentation/agent-list-status'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import type { HomeAgentEntry } from '../worktree/catalog/home-worktree-info'
import { buildAgentList, DEFAULT_AGENT_LIST_VIEW } from './agent-list-model'

const NOW = 1_000_000

// One pane as worktree.ps sends it, carrying the verdict the desktop Agents list published for it.
function entry(paneKey: string, status: AgentListStatus, childOf?: string): HomeAgentEntry {
  const agent: RuntimeWorktreeAgentRow = {
    paneKey,
    parentPaneKey: childOf ?? null,
    state: 'done',
    agentType: 'claude',
    prompt: paneKey,
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: NOW,
    updatedAt: NOW,
    activity: {
      listed: true,
      status,
      unread: false,
      clearable: false,
      sortAt: NOW,
      title: paneKey,
      ...(childOf ? { childOf } : {})
    }
  }
  return { worktreeId: 'wt', workspaceName: 'wt', repo: 'repo', branch: 'b', agent }
}

describe('buildAgentList Status grouping', () => {
  it('holds the same Needs you set as the desktop Agents list, each agent once under its own status', () => {
    const agents = [
      entry('lead', 'waiting'),
      entry('worker-working', 'working', 'lead'),
      entry('worker-done', 'done', 'lead'),
      entry('worker-blocked', 'blocked', 'lead'),
      entry('asks', 'permission'),
      entry('failed', 'failed'),
      entry('unconfirmed', 'unconfirmed'),
      entry('interrupted', 'interrupted'),
      entry('working', 'monitoring')
    ]
    const { sections } = buildAgentList(
      {
        hosts: [{ id: 'host' }],
        hostStates: { host: 'connected' },
        worktreeInfo: { host: { hostId: 'host', totalWorktrees: 1, activeCount: 1, agents } },
        now: NOW
      },
      { view: DEFAULT_AGENT_LIST_VIEW, hostFilter: null, query: '' }
    )
    expect(
      sections.map((section) => [
        section.kind,
        section.rows.map((row) => [row.key.slice('host:'.length), row.workers.length])
      ])
    ).toEqual([
      [
        'needs-you',
        [
          ['lead', 0],
          ['worker-blocked', 0],
          ['asks', 0]
        ]
      ],
      [
        'failed',
        [
          ['failed', 0],
          ['unconfirmed', 0]
        ]
      ],
      [
        'working',
        [
          ['worker-working', 0],
          ['working', 0]
        ]
      ],
      [
        'done',
        [
          ['interrupted', 0],
          ['worker-done', 0]
        ]
      ]
    ])
  })
})
