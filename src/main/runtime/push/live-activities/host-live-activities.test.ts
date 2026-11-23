import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../../rpc/server/pairing/device-registry'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { LiveActivityPush } from '../../../../shared/notifications/live-activity-contract'
import { HostLiveActivities } from './host-live-activities'

it('keeps overlapping registrations accepted and delivers the newest terminal state after an in-flight push', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(20_000)
  const directory = mkdtempSync(join(tmpdir(), 'orca-activity-flight-'))
  const registry = new DeviceRegistry(directory)
  const phone = registry.addDevice('Phone', 'mobile')
  const parentTabId = '11111111-1111-4111-8111-111111111111'
  const leafId = '22222222-2222-4222-8222-222222222222'
  const tab = {
    type: 'terminal' as const,
    id: 'terminal-tab',
    parentTabId,
    leafId,
    title: 'Private project',
    isActive: true,
    status: 'ready' as const,
    terminal: 'term',
    agentStatus: {
      state: 'working' as const,
      paneKey: `${parentTabId}:${leafId}`,
      prompt: '',
      updatedAt: 20_000,
      stateStartedAt: 18_000,
      stateHistory: []
    }
  }
  const frame: RuntimeMobileSessionTabsResult = {
    worktree: 'folder:workspace',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeTabId: tab.id,
    activeTabType: 'terminal',
    activeGroupId: null,
    tabs: [tab]
  }
  let publish: (frame: RuntimeMobileSessionTabsResult) => void = () => {}
  const entered = Promise.withResolvers<void>()
  const accepted = Promise.withResolvers<void>()
  const wire: LiveActivityPush[] = []
  const host = new HostLiveActivities(
    {
      listMobileSessionTabs: async () => frame,
      onMobileSessionTabsChanged: (listener) => {
        publish = (next) => listener(next, next.snapshotVersion)
        return () => {}
      }
    },
    registry,
    {
      sendLiveActivity: async (push) => {
        wire.push(push)
        entered.resolve()
        await accepted.promise
        return 'sent'
      }
    }
  )
  try {
    const registration = {
      activityId: 'activity',
      token: 'aabb',
      apnsEnvironment: 'sandbox' as const,
      worktreeId: 'folder:workspace',
      paneKey: `${parentTabId}:${leafId}`,
      showNames: false
    }
    const first = host.register(phone.deviceId, registration)
    await entered.promise
    const concurrent = host.register(phone.deviceId, registration)
    publish({
      ...frame,
      snapshotVersion: 2,
      tabs: [
        {
          ...tab,
          agentStatus: {
            ...tab.agentStatus,
            state: 'done',
            stateStartedAt: 20_000,
            mainAgent: { state: 'done', stateStartedAt: 20_000, outcome: 'failure' }
          }
        }
      ]
    })
    accepted.resolve()
    expect(await first).toEqual({ registered: true })
    expect(await concurrent).toEqual({ registered: true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(wire.at(-1)).toEqual({
      token: 'aabb',
      apnsEnvironment: 'sandbox',
      timestamp: 21,
      event: 'end',
      content: { state: 'failed', title: 'Orca', stateStartedAt: 20, updatedAt: 21 }
    })
    expect(registry.getDevice(phone.deviceId)?.liveActivities).toEqual([])
  } finally {
    host.stop()
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  }
})
