import { describe, expect, it } from 'vitest'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { hostAgents, everyRow } from '../agents/agent-list-rows'
import { homeAgentEntries, type HostWorktreeInfo } from '../worktree/catalog/home-worktree-info'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import {
  pickRelayedServers,
  withRelayedServerAgents,
  type HomeRelayedServersRead
} from './home-relayed-servers'

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

function server(health: MobileRelayHost['health'] = 'available'): MobileRelayHost {
  return { hostId: SERVER, label: 'Build box', health, relay: 'ready', installationId: 'server-1' }
}

const relaying = (hosts: MobileRelayHost[], live = true): HomeRelayedServersRead => ({
  data: { deltas: true, hosts },
  live
})

describe('relayed server agents on Home', () => {
  it('reads a server two desktops relay through the first only, apart from the desktop’s own pane', () => {
    const picks = pickRelayedServers(['desk-a', 'desk-b'], {
      'desk-a': relaying([server()]),
      'desk-b': relaying([server()])
    })
    expect(picks.map((pick) => pick.desktopHostId)).toEqual(['desk-a'])
    const merged = withRelayedServerAgents(
      { 'desk-a': desktopInfo('desk-a'), 'desk-b': desktopInfo('desk-b') },
      picks,
      [[row('server-ws', SERVER, 'tab-1:leaf-1')]]
    )
    const input = {
      hosts: [{ id: 'desk-a' }, { id: 'desk-b' }],
      hostStates: { 'desk-a': 'connected' as const, 'desk-b': 'connected' as const },
      worktreeInfo: merged,
      now: 2
    }
    const rowsA = everyRow(hostAgents(input, 'desk-a').roots)
    const serverRows = rowsA.filter((r) => r.entry.executionHost)
    expect(serverRows).toHaveLength(1)
    expect(serverRows[0]?.entry.executionHost).toEqual({ id: SERVER, label: 'Build box' })
    // The desktop reads and clears only its own agents.
    expect(serverRows[0]?.unread).toBeUndefined()
    expect(serverRows[0]?.clearable).toBe(false)
    expect(new Set(rowsA.map((r) => r.key)).size).toBe(2)
  })

  it('lists a server paired directly only under its own pairing, even while that pairing is offline', () => {
    const picks = pickRelayedServers(['desk-a', 'server-direct'], {
      'desk-a': relaying([server()]),
      'server-direct': {
        data: { installationId: 'server-1', deltas: true, hosts: [] },
        live: false
      }
    })
    expect(picks).toEqual([])
  })

  it('reads no agents from a relayed server that is not available', () => {
    const picks = pickRelayedServers(['desk-a'], { 'desk-a': relaying([server('disconnected')]) })
    expect(picks).toEqual([])
  })
})
