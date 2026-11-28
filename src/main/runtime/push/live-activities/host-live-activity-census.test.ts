import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../../rpc/server/pairing/device-registry'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { LiveActivityPush } from '../../../../shared/notifications/live-activity-contract'
import { HostLiveActivities } from './host-live-activities'

it('keeps known sessions from a partial census but discards unrefreshed frames after a failed census', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(20_000)
  const directory = mkdtempSync(join(tmpdir(), 'orca-activity-census-'))
  const registry = new DeviceRegistry(directory)
  const phone = registry.addDevice('Phone', 'mobile')
  const parentTabId = '11111111-1111-4111-8111-111111111111'
  const leafId = '22222222-2222-4222-8222-222222222222'
  const frame: RuntimeMobileSessionTabsResult = {
    worktree: 'folder:workspace',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeTabId: 'terminal-tab',
    activeTabType: 'terminal',
    activeGroupId: null,
    tabs: [
      {
        type: 'terminal',
        id: 'terminal-tab',
        parentTabId,
        leafId,
        title: 'Private project',
        isActive: true,
        status: 'ready',
        terminal: 'term',
        agentStatus: {
          state: 'working',
          paneKey: `${parentTabId}:${leafId}`,
          prompt: '',
          updatedAt: 20_000,
          stateStartedAt: 18_000,
          stateHistory: []
        }
      }
    ]
  }
  let failed = false
  const wire: LiveActivityPush[] = []
  const host = new HostLiveActivities(
    {
      listAllMobileSessionTabsInventory: async () => {
        if (failed) {
          throw new Error('Inventory unavailable')
        }
        return { snapshots: [frame] }
      },
      projectLocalAgentSessionTabs: (snapshot) => ({ frame: snapshot, complete: true }),
      restoreStructuredAgentSessionTabs: async () => {},
      onMobileSessionTabsChanged: () => () => {}
    },
    registry,
    {
      registerLiveActivityOverview: async () => true,
      sendLiveActivity: async (push) => {
        wire.push(push)
        return 'sent'
      }
    }
  )
  try {
    expect(
      await host.register(phone.deviceId, {
        activityId: 'activity',
        schemaVersion: 2,
        overviewId: '33333333-3333-4333-8333-333333333333',
        scopeKey: 'a'.repeat(64),
        showNames: false
      })
    ).toEqual({ registered: true })
    expect(wire.at(-1)?.content.counts.working).toBe(1)
    expect(wire.at(-1)?.content.complete).toBe(false)
    failed = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(wire.at(-1)?.content.counts.working).toBe(0)
    expect(wire.at(-1)?.content.sessions).toEqual([])
    expect(wire.at(-1)?.content.complete).toBe(false)
  } finally {
    host.stop()
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  }
})
