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
      listAllMobileSessionTabsInventory: async () => ({ snapshots: [frame], authoritative: true }),
      projectLocalAgentSessionTabs: (snapshot) => ({ frame: snapshot, complete: true }),
      restoreStructuredAgentSessionTabs: async () => {},
      onMobileSessionTabsChanged: (listener) => {
        publish = (next) => listener(next, next.snapshotVersion)
        return () => {}
      }
    },
    registry,
    {
      registerLiveActivityOverview: async () => true,
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
      schemaVersion: 2 as const,
      overviewId: '33333333-3333-4333-8333-333333333333',
      scopeKey: 'a'.repeat(64),
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
    const latest = wire.at(-1)!
    expect(latest.event).toBe('update')
    expect(latest.sequence).toBe(2)
    expect(latest.content.counts).toEqual({
      working: 0,
      attention: 0,
      failed: 1,
      done: 0,
      unavailable: 0
    })
    expect(latest.content.sessions.map(({ title, state }) => [title, state])).toEqual([
      ['', 'failed']
    ])
    expect(registry.getDevice(phone.deviceId)?.liveActivities).toHaveLength(1)
  } finally {
    host.stop()
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('never sends a contribution against a bootstrap superseded while registration was in flight', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(20_000)
  const directory = mkdtempSync(join(tmpdir(), 'orca-activity-bootstrap-'))
  const registry = new DeviceRegistry(directory)
  const phone = registry.addDevice('Phone', 'mobile')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let destination = ''
  const deliveries: string[] = []
  const host = new HostLiveActivities(
    {
      listAllMobileSessionTabsInventory: async () => ({ snapshots: [], authoritative: true }),
      projectLocalAgentSessionTabs: (frame) => ({ frame, complete: true }),
      restoreStructuredAgentSessionTabs: async () => {},
      onMobileSessionTabsChanged: () => () => {}
    },
    registry,
    {
      registerLiveActivityOverview: async (input) => {
        if (input.revision === 1) {
          entered.resolve()
          await release.promise
        }
        destination = input.token
        return true
      },
      sendLiveActivity: async () => {
        deliveries.push(destination)
        return 'sent'
      }
    }
  )
  try {
    const registration = {
      activityId: 'activity',
      schemaVersion: 2 as const,
      overviewId: '33333333-3333-4333-8333-333333333333',
      scopeKey: 'a'.repeat(64),
      showNames: false,
      bootstrap: {
        revision: 1,
        showNames: false,
        discoveryComplete: true,
        controlKey: 'b'.repeat(64),
        token: 'aabb',
        apnsEnvironment: 'sandbox' as const,
        scopes: ['c'.repeat(64)]
      }
    }
    const first = host.register(phone.deviceId, registration)
    await entered.promise
    const replacement = host.register(phone.deviceId, {
      ...registration,
      bootstrap: { ...registration.bootstrap, revision: 2, token: 'ccdd' }
    })
    release.resolve()
    await Promise.all([first, replacement])
    await vi.advanceTimersByTimeAsync(1001)
    expect(deliveries).toEqual(['ccdd'])
  } finally {
    host.stop()
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('registers a replacement bootstrap before sending after an in-flight census', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(20_000)
  const directory = mkdtempSync(join(tmpdir(), 'orca-activity-census-bootstrap-'))
  const registry = new DeviceRegistry(directory)
  const phone = registry.addDevice('Phone', 'mobile')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let census = 0
  let destination = ''
  const deliveries: string[] = []
  const host = new HostLiveActivities(
    {
      listAllMobileSessionTabsInventory: async () => {
        if (census++ > 0) {
          entered.resolve()
          await release.promise
          return { snapshots: [] }
        }
        return { snapshots: [], authoritative: true }
      },
      projectLocalAgentSessionTabs: (frame) => ({ frame, complete: true }),
      restoreStructuredAgentSessionTabs: async () => {},
      onMobileSessionTabsChanged: () => () => {}
    },
    registry,
    {
      registerLiveActivityOverview: async (input) => {
        destination = input.token
        return true
      },
      sendLiveActivity: async () => {
        deliveries.push(destination)
        return 'sent'
      }
    }
  )
  const registration = {
    activityId: 'activity',
    schemaVersion: 2 as const,
    overviewId: '33333333-3333-4333-8333-333333333333',
    scopeKey: 'a'.repeat(64),
    showNames: false,
    bootstrap: {
      revision: 1,
      showNames: false,
      discoveryComplete: true,
      controlKey: 'b'.repeat(64),
      token: 'aabb',
      apnsEnvironment: 'sandbox' as const,
      scopes: ['c'.repeat(64)]
    }
  }
  try {
    await host.register(phone.deviceId, registration)
    const advancing = vi.advanceTimersByTimeAsync(5 * 60_000)
    await entered.promise
    const replacement = host.register(phone.deviceId, {
      ...registration,
      bootstrap: { ...registration.bootstrap, revision: 2, token: 'ccdd' }
    })
    release.resolve()
    await advancing
    await replacement
    await vi.advanceTimersByTimeAsync(1001)
    expect(deliveries).toEqual(['aabb', 'ccdd'])
  } finally {
    host.stop()
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  }
})
