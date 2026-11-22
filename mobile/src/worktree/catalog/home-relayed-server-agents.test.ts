import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { hostAgents, everyRow } from '../../agents/agent-list-rows'
import type { Worktree } from '../workspace-list/workspace-list-types'
import {
  homeAgentEntries,
  withRelayedServerAgents,
  type HostWorktreeInfo
} from './home-worktree-info'

const SERVER = 'runtime:build-box'

function agent(paneKey: string): RuntimeWorktreeAgentRow {
  return {
    paneKey,
    parentPaneKey: null,
    state: 'blocked',
    agentType: 'claude',
    prompt: '',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1,
    updatedAt: 1,
    activity: {
      listed: true,
      status: 'blocked',
      unread: true,
      clearable: true,
      sortAt: 1,
      title: paneKey
    }
  }
}

function row(worktreeId: string, hostId: `runtime:${string}`, paneKey: string): Worktree {
  return {
    worktreeId,
    hostId,
    repoId: 'repo',
    repo: 'repo',
    branch: 'main',
    displayName: worktreeId,
    path: `/work/${worktreeId}`,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    unread: false,
    isPinned: false,
    linkedPR: null,
    isArchived: false,
    agents: [agent(paneKey)]
  }
}

function desktopInfo(hostId: string): HostWorktreeInfo {
  const own = {
    worktreeId: `${hostId}-own`,
    repo: 'repo',
    branch: 'main',
    displayName: 'own',
    liveTerminalCount: 1,
    agents: [agent('tab-1:leaf-1')]
  }
  return { hostId, totalWorktrees: 1, activeCount: 1, agents: homeAgentEntries([own]) }
}

const relayed = (installationId?: string) => ({
  hosts: [
    {
      hostId: SERVER,
      label: 'Build box',
      health: 'available' as const,
      relay: 'ready' as const,
      ...(installationId ? { installationId } : {})
    }
  ],
  worktrees: [row('server-ws', SERVER, 'tab-1:leaf-1')]
})

describe('relayed server agents on Home', () => {
  it('lists a server two desktops relay once, apart from the desktop’s own pane of the same key', () => {
    const merged = withRelayedServerAgents(
      ['desk-a', 'desk-b'],
      { 'desk-a': desktopInfo('desk-a'), 'desk-b': desktopInfo('desk-b') },
      { 'desk-a': { servers: relayed('server-1') }, 'desk-b': { servers: relayed('server-1') } }
    )
    const input = {
      hosts: [{ id: 'desk-a' }, { id: 'desk-b' }],
      hostStates: { 'desk-a': 'connected' as const, 'desk-b': 'connected' as const },
      worktreeInfo: merged,
      now: 2
    }
    const rowsA = everyRow(hostAgents(input, 'desk-a').roots)
    const rowsB = everyRow(hostAgents(input, 'desk-b').roots)

    const serverRows = [...rowsA, ...rowsB].filter((r) => r.entry.executionHost)
    expect(serverRows).toHaveLength(1)
    expect(serverRows[0]?.entry.executionHost).toEqual({ id: SERVER, label: 'Build box' })
    // The desktop reads and clears only its own agents.
    expect(serverRows[0]?.unread).toBeUndefined()
    expect(serverRows[0]?.clearable).toBe(false)
    expect(new Set(rowsA.map((r) => r.key)).size).toBe(2)
    expect(rowsB).toHaveLength(1)
  })

  it('lists a server paired directly only under its own pairing', () => {
    const merged = withRelayedServerAgents(
      ['desk-a', 'server-direct'],
      { 'desk-a': desktopInfo('desk-a'), 'server-direct': desktopInfo('server-direct') },
      {
        'desk-a': { servers: relayed('server-1') },
        'server-direct': { installationId: 'server-1', servers: { hosts: [], worktrees: [] } }
      }
    )
    expect(merged['desk-a']?.agents?.some((entry) => entry.executionHost)).toBe(false)
  })
})
