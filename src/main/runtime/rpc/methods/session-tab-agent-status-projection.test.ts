import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-types'
import { projectSessionTabAgentStatus } from './session-tab-agent-status-projection'

function makeSnapshot(sessionBoundary: boolean): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: 'tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1::leaf-1',
        title: 'Claude',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        isActive: true,
        agentStatus: {
          state: 'done',
          prompt: '',
          updatedAt: 100,
          stateStartedAt: 100,
          paneKey: 'tab-1:leaf-1',
          stateHistory: [],
          sessionBoundary
        }
      }
    ]
  }
}

describe('projectSessionTabAgentStatus', () => {
  it('projects structured tabs and dangling group focus out of old clients', () => {
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      ...makeSnapshot(false),
      activeGroupId: 'group-a',
      activeTabId: 'agent-session:session-a',
      activeTabType: 'agent-session',
      tabGroups: [
        {
          id: 'group-a',
          activeTabId: 'agent-session:session-a',
          tabOrder: ['tab-1::leaf-1', 'agent-session:session-a'],
          recentTabIds: ['agent-session:session-a', 'tab-1::leaf-1']
        },
        {
          id: 'group-b',
          activeTabId: 'agent-session:session-b',
          tabOrder: ['agent-session:session-b']
        }
      ],
      tabGroupLayout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-a' },
        second: { type: 'leaf', groupId: 'group-b' }
      },
      tabs: [
        { ...makeSnapshot(false).tabs[0]!, isActive: false },
        {
          type: 'agent-session',
          id: 'agent-session:session-a',
          title: 'Codex Chat',
          sessionId: 'session-a',
          agent: 'codex',
          isActive: true
        },
        {
          type: 'agent-session',
          id: 'agent-session:session-b',
          title: 'Codex Chat',
          sessionId: 'session-b',
          agent: 'codex',
          isActive: false
        }
      ]
    }
    const oldClient = projectSessionTabAgentStatus(snapshot, 'mobile', [])
    expect(oldClient.tabs.map((tab) => tab.type)).toEqual(['terminal'])
    expect(oldClient.activeTabId).toBe('tab-1::leaf-1')
    expect(oldClient.activeTabType).toBe('terminal')
    expect(oldClient.tabs[0]?.isActive).toBe(true)
    expect(oldClient.tabGroups?.[0]?.tabOrder).toEqual(['tab-1::leaf-1'])
    expect(oldClient.tabGroups).toHaveLength(1)
    expect(oldClient.tabGroupLayout).toEqual({ type: 'leaf', groupId: 'group-a' })

    expect(
      projectSessionTabAgentStatus(snapshot, 'mobile', [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
      ])
    ).toEqual(oldClient)

    const capable = projectSessionTabAgentStatus(snapshot, 'runtime', [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])
    expect(capable).toBe(snapshot)
  })

  it('withholds legacy Claude rows from paired structured clients', () => {
    const snapshot = {
      ...makeSnapshot(false),
      tabs: [
        {
          type: 'agent-session',
          id: 'agent-session:codex',
          title: 'Codex Chat',
          sessionId: 'codex',
          agent: 'codex',
          isActive: true
        },
        {
          type: 'agent-session',
          id: 'agent-session:claude',
          title: 'Claude Chat',
          sessionId: 'claude',
          agent: 'claude',
          isActive: false
        }
      ],
      activeTabId: 'agent-session:codex',
      activeTabType: 'agent-session'
    } as unknown as RuntimeMobileSessionTabsSnapshot

    expect(
      projectSessionTabAgentStatus(snapshot, 'runtime', [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
      ]).tabs.map((tab) => tab.id)
    ).toEqual(['agent-session:codex'])
  })

  it('withholds session boundaries from legacy paired clients', () => {
    const projected = projectSessionTabAgentStatus(makeSnapshot(true), 'runtime', [])

    expect(projected.tabs[0]).not.toHaveProperty('agentStatus')
  })

  it('publishes session boundaries to clients that negotiated them', () => {
    const snapshot = makeSnapshot(true)

    expect(
      projectSessionTabAgentStatus(snapshot, 'runtime', [AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY])
    ).toBe(snapshot)
  })

  it('does not alter local, mobile, or real-completion projections', () => {
    const localBoundary = makeSnapshot(true)
    const mobileBoundary = makeSnapshot(true)
    const runtimeCompletion = makeSnapshot(false)

    expect(projectSessionTabAgentStatus(localBoundary, undefined, undefined)).toBe(localBoundary)
    expect(projectSessionTabAgentStatus(mobileBoundary, 'mobile', [])).toBe(mobileBoundary)
    expect(projectSessionTabAgentStatus(runtimeCompletion, 'runtime', [])).toBe(runtimeCompletion)
  })
})
