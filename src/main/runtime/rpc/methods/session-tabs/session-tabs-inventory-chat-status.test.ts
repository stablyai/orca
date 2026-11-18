import { expect, it, vi } from 'vitest'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { subscribeSessionTabsInventory } from './session-tabs-inventory'

// Each frame restamps the chat's status freshness, as every hook event does for a running agent.
class RestampingRuntime extends OrcaRuntimeService {
  stamp = 1_000
  protected override toMobileSessionTabsResult(snapshot: RuntimeMobileSessionTabsSnapshot) {
    const frame = super.toMobileSessionTabsResult(snapshot)
    this.stamp += 1
    return {
      ...frame,
      tabs: [
        ...frame.tabs,
        {
          type: 'agent-session' as const,
          id: 'chat-tab',
          title: 'Chat',
          sessionId: 'session-1',
          agent: 'claude' as const,
          isActive: false,
          chatStatus: { state: 'working' as const, updatedAt: this.stamp }
        }
      ]
    }
  }
}

it('sends desktops a timestamp-only chat status change as a version-only frame', async () => {
  const runtime = new RestampingRuntime()
  const snapshot = (snapshotVersion: number): RuntimeMobileSessionTabsSnapshot => ({
    worktree: 'wt-chat-status',
    publicationEpoch: 'epoch-current',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  })
  await runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [snapshot(1)] })
  const internals = runtime as unknown as {
    refreshMobileSessionPtyInventory: () => Promise<unknown>
    mobileSessionTabsNotifyCoalescer: { flushAll: () => void }
  }
  vi.spyOn(internals, 'refreshMobileSessionPtyInventory').mockResolvedValue({
    livePtyIds: new Set(),
    allLivePtyIds: new Set(),
    terminalIdentityByPtyId: new Map(),
    queriedHostIds: new Set(['local'])
  })
  const emit = vi.fn<(event: unknown) => void>()
  await subscribeSessionTabsInventory(
    {
      runtime,
      connectionId: 'conn-chat-status',
      requestId: 'req-chat-status',
      pairedDeviceId: 'paired-chat-status',
      // The local desktop window subscribes without a client kind.
      clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
    },
    emit
  )
  await runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [snapshot(2)] })
  internals.mobileSessionTabsNotifyCoalescer.flushAll()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await runtime['agentProjections'].senders.withPreparedPublication(() => undefined, false)

  const [census, update] = emit.mock.calls.map(([event]) => event) as {
    snapshots?: { tabs: unknown[] }[]
    tabs?: unknown[]
    snapshotVersion?: number
  }[]
  const chat = { type: 'agent-session', id: 'chat-tab', sessionId: 'session-1' }
  expect(census?.snapshots?.[0]?.tabs).toEqual([expect.objectContaining(chat)])
  expect(census?.snapshots?.[0]?.tabs[0]).not.toHaveProperty('chatStatus')
  expect(update).toMatchObject({ type: 'updated', snapshotVersion: 2 })
  expect(update?.tabs).toEqual(census?.snapshots?.[0]?.tabs)
})
