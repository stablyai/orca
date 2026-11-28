import { expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { agentOverviewContent } from './agent-overview-content'

it('keeps fresh authority evidence over a restored or restamped alias of the same conversation', () => {
  const frame: RuntimeMobileSessionTabsResult = {
    worktree: 'folder:workspace',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeTabId: 'fresh',
    activeTabType: 'terminal',
    activeGroupId: null,
    tabs: [
      {
        type: 'terminal',
        id: 'fresh',
        parentTabId: '11111111-1111-4111-8111-111111111111',
        leafId: '22222222-2222-4222-8222-222222222222',
        title: 'Project',
        isActive: true,
        status: 'ready',
        terminal: 'term',
        agentStatus: {
          orcaSessionId: 'conversation',
          state: 'working',
          paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
          prompt: '',
          updatedAt: 20_000,
          evidenceObservedAt: 20_000,
          stateStartedAt: 18_000,
          stateHistory: []
        }
      }
    ]
  }
  const original = frame.tabs[0]
  if (!original || original.type !== 'terminal' || !original.agentStatus) {
    throw new Error('terminal fixture missing')
  }
  for (const restoredUnconfirmed of [true, false]) {
    const duplicate: RuntimeMobileSessionTabsResult = {
      ...frame,
      snapshotVersion: 2,
      tabs: [
        {
          ...original,
          id: 'replayed',
          leafId: '44444444-4444-4444-8444-444444444444',
          agentStatus: {
            ...original.agentStatus,
            state: 'waiting',
            updatedAt: 21_000,
            evidenceObservedAt: 19_000,
            restoredUnconfirmed
          }
        }
      ]
    }
    const result = agentOverviewContent(
      [{ ...frame, tabs: [original, ...duplicate.tabs] }],
      'activity',
      false,
      22_000
    )
    expect(result.counts).toEqual({ working: 1, attention: 0, done: 0, failed: 0, unavailable: 0 })
    expect(result.sessions.map((session) => session.state)).toEqual(['working'])
  }
})
