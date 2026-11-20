import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { AgentListPublication } from '../../../../../shared/agent-status/presentation/agent-list-status'
import type { RuntimeClientEvent } from '../../../../../shared/remote-runtime/session-graph/runtime-client-events'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { RpcDispatcher } from '../../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'

const PANE_KEY = 'tab-a:11111111-1111-4111-8111-111111111111'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stream reads only these fields of a host terminal tab.
const SNAPSHOT = {
  worktree: 'wt-unread',
  publicationEpoch: 'epoch',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: 'leaf-a',
  activeTabType: 'terminal',
  tabs: [
    {
      type: 'terminal',
      id: 'leaf-a',
      title: 'claude',
      parentTabId: 'tab-a',
      leafId: '11111111-1111-4111-8111-111111111111',
      isActive: true
    }
  ]
} as RuntimeMobileSessionTabsResult

function publication(unread: boolean, sortAt = 1): AgentListPublication {
  return {
    publishedAt: sortAt,
    verdicts: {
      [PANE_KEY]: {
        listed: true,
        status: 'done',
        unread,
        clearable: true,
        sortAt,
        title: 'claude'
      }
    }
  }
}

describe('session.tabs.subscribe unread marks for phones', () => {
  it('re-sends a tab when the desktop reads it, and stays quiet when its verdict does not move', async () => {
    let agentList = publication(true)
    let onEvent: ((event: RuntimeClientEvent) => void) | undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: session.tabs.subscribe for a phone reads only these members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: () => ({}),
      listMobileSessionTabs: vi.fn().mockResolvedValue(SNAPSHOT),
      registerSubscriptionCleanup: vi.fn(),
      onMobileSessionTabsChanged: vi.fn(() => () => {}),
      readAgentListPublication: () => agentList,
      onClientEvent: vi.fn((listener: (event: RuntimeClientEvent) => void) => {
        onEvent = listener
        return () => {}
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const frames: { type: string; tabs?: { unread?: true }[] }[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'req-1',
        authToken: 'tok',
        method: 'session.tabs.subscribe',
        params: { worktree: 'id:wt-unread' }
      },
      (message) => frames.push(JSON.parse(message).result),
      { clientKind: 'mobile' }
    )
    expect(frames).toHaveLength(1)
    expect(frames[0]!.tabs![0]!.unread).toBe(true)

    // A busy agent's recency moves on every step without changing what is unread.
    agentList = publication(true, 2)
    onEvent!({ type: 'agentListChanged' })
    expect(frames).toHaveLength(1)

    agentList = publication(false, 3)
    onEvent!({ type: 'agentListChanged' })
    expect(frames).toHaveLength(2)
    expect(frames[1]!.type).toBe('updated')
    expect(frames[1]!.tabs![0]!.unread).toBeUndefined()
  })
})
