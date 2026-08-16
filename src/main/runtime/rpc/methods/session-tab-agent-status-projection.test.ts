import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
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
