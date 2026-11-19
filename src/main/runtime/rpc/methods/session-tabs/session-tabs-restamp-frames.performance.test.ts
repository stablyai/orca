import { expect, it } from 'vitest'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import type { PtyControllerInventory } from '../../../terminal/lifecycle/runtime-pty-controller-contract'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { subscribeSessionTabsInventory } from './session-tabs-inventory'

// Perf contract (#43951): every hook event restamps a running chat's status freshness, and the desktop got a chat-tab
// frame for each one (about 1.3 frames/s per running agent, ~143/s idle at fleet scale) that it then reconciled.
// Each frame below restamps the chat's status freshness, as every hook event does for a running agent.
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

it('sends desktops no chat-status payload across 50 timestamp-only restamps', async () => {
  const runtime = new RestampingRuntime()
  await runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [snapshot(1)] })
  const events: unknown[] = []
  await subscribeSessionTabsInventory(
    {
      runtime,
      connectionId: 'conn-restamps',
      requestId: 'req-restamps',
      pairedDeviceId: 'paired-restamps',
      // The local desktop window subscribes without a client kind.
      clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
    },
    (event) => events.push(event)
  )
  for (let version = 2; version <= 51; version += 1) {
    await runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [snapshot(version)]
    })
    runtime.flushPublications()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await runtime['agentProjections'].senders.withPreparedPublication(() => undefined, false)
  }

  const updates = events.filter((event) => (event as { type?: string }).type === 'updated') as {
    snapshotVersion: number
  }[]
  expect(updates.map((event) => event.snapshotVersion)).toEqual(
    Array.from({ length: 50 }, (_, index) => index + 2)
  )
  expect(events.filter((event) => JSON.stringify(event).includes('chatStatus'))).toEqual([])
})
