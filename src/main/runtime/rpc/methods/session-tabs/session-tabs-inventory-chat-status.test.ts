import { expect, it } from 'vitest'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import type { PtyControllerInventory } from '../../../terminal/lifecycle/runtime-pty-controller-contract'
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
  protected override async refreshMobileSessionPtyInventory(): Promise<PtyControllerInventory> {
    return {
      livePtyIds: new Set(),
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map(),
      queriedHostIds: new Set([LOCAL_EXECUTION_HOST_ID])
    }
  }
  flushPublications(): void {
    this.mobileSessionTabsNotifyCoalescer.flushAll()
  }
}

function snapshot(snapshotVersion: number): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'wt-chat-status',
    publicationEpoch: 'epoch-current',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

it('sends desktops a timestamp-only chat status change as a version-only frame', async () => {
  const runtime = new RestampingRuntime()
  await runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [snapshot(1)] })
  const events: unknown[] = []
  await subscribeSessionTabsInventory(
    {
      runtime,
      connectionId: 'conn-chat-status',
      requestId: 'req-chat-status',
      pairedDeviceId: 'paired-chat-status',
      // The local desktop window subscribes without a client kind.
      clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
    },
    (event) => events.push(event)
  )
  await runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [snapshot(2)] })
  runtime.flushPublications()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await runtime['agentProjections'].senders.withPreparedPublication(() => undefined, false)

  const chat = expect.objectContaining({
    type: 'agent-session',
    id: 'chat-tab',
    sessionId: 'session-1'
  })
  expect(events).toEqual([
    expect.objectContaining({
      type: 'snapshots',
      snapshots: [expect.objectContaining({ tabs: [chat] })]
    }),
    expect.objectContaining({ type: 'updated', snapshotVersion: 2, tabs: [chat] })
  ])
  expect(JSON.stringify(events)).not.toContain('chatStatus')
})
