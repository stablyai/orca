import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { sha256 } from '@noble/hashes/sha256'
import { loadHostCatalog } from '../transport/host-store'
import type { HostCatalogEntry } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import { resetHostNotificationSessionsForTests } from './notification-reconnect-catchup'

// Why this file exists: a push the OS drew while Orca was closed never runs through
// the foreground handler, so nothing marks it seen. The reconnect catch-up then
// replays the same event and the user gets a second banner for it.

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 'high' },
  setNotificationChannelAsync: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(async () => []),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  dismissNotificationAsync: vi.fn()
}))

vi.mock('react-native', () => ({ Platform: { OS: 'ios', Version: 18 } }))

vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn() }))

const WATERMARK_KEY = 'orca:mobileNotificationsWatermark:host-1'
const storage = new Map<string, string>()

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value)
    })
  }
}))

vi.mock('../storage/preferences', () => ({ loadPushNotificationsEnabled: vi.fn() }))

const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index)
const publicKeyB64 = Buffer.from(publicKey).toString('base64')
const hostFingerprint = Buffer.from(sha256(publicKey)).toString('base64url').slice(0, 16)

function flushAsync(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 10)
  })
}

function presentTray(entries: readonly Record<string, unknown>[]): void {
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue(
    entries.map((orca, index) => ({
      request: { identifier: `tray-${index}`, content: { data: { orca } } }
    })) as never
  )
}

function shownTitles(): string[] {
  return vi
    .mocked(Notifications.scheduleNotificationAsync)
    .mock.calls.map((call) => (call[0] as { content: { title: string } }).content.title)
}

function persistedSeq(): number {
  return (JSON.parse(storage.get(WATERMARK_KEY) ?? '{}') as { seq?: number }).seq ?? 0
}

/** A catch-up that replays seq 6 and 7 for host-1. */
function catchUpClient(): { client: RpcClient; ready: () => void } {
  let onData: ((data: unknown) => void) | null = null
  const client = {
    subscribe: vi.fn((_method: string, _params: unknown, callback: (data: unknown) => void) => {
      onData = callback
      return vi.fn()
    }),
    getState: vi.fn(() => 'connected'),
    sendRequest: vi.fn(async (method: string) => {
      if (method === 'notifications.getMissedSince') {
        return {
          ok: true,
          result: {
            notifications: [
              {
                type: 'notification',
                title: 'm6',
                body: 'b',
                notificationId: 'a:6',
                notificationSeq: 6
              },
              {
                type: 'notification',
                title: 'm7',
                body: 'b',
                notificationId: 'a:7',
                notificationSeq: 7
              }
            ]
          }
        } as never
      }
      return { ok: true, result: undefined } as never
    })
  } as unknown as RpcClient
  return {
    client,
    ready: () => onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })
  }
}

async function reopenWithTray(): Promise<void> {
  storage.set(WATERMARK_KEY, JSON.stringify({ seq: 5, epoch: 'epoch-1' }))
  const { client, ready } = catchUpClient()
  subscribeToDesktopNotifications(client, 'host-1')
  ready()
  await flushAsync()
}

beforeEach(() => {
  vi.clearAllMocks()
  storage.clear()
  resetHostNotificationSessionsForTests()
  vi.mocked(loadHostCatalog).mockResolvedValue([
    { id: 'host-1', publicKeyB64 }
  ] as unknown as HostCatalogEntry[])
  vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
    status: 'granted',
    canAskAgain: true
  } as never)
  vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('sched-1')
  vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([])
})

describe('reopen after a push the OS showed while Orca was closed', () => {
  it('replays only the events still missing from the tray', async () => {
    presentTray([
      { hostFingerprint, notificationId: 'a:6', notificationSeq: 6, notificationEpoch: 'epoch-1' }
    ])

    await reopenWithTray()

    expect(shownTitles()).toEqual(['m7'])
  })

  it('leaves the watermark to the replay rather than jumping it to the push seq', async () => {
    presentTray([
      { hostFingerprint, notificationId: 'a:9', notificationSeq: 9, notificationEpoch: 'epoch-1' }
    ])

    await reopenWithTray()

    // Seq 9 in the tray says one event was shown, not that 6..8 were; advancing past
    // them would make the desktop cut them out of every later catch-up.
    expect(shownTitles()).toEqual(['m6', 'm7'])
    expect(persistedSeq()).toBe(7)
  })

  it('still replays an event a coalesced summary only counted', async () => {
    presentTray([
      {
        hostFingerprint,
        notificationId: 'a:6',
        notificationSeq: 6,
        notificationEpoch: 'epoch-1',
        coalescedCount: 3
      }
    ])

    await reopenWithTray()

    expect(shownTitles()).toEqual(['m6', 'm7'])
  })

  it('ignores a tray entry pushed for a different paired host', async () => {
    presentTray([
      {
        hostFingerprint: '0123456789abcdef',
        notificationId: 'a:6',
        notificationSeq: 6,
        notificationEpoch: 'epoch-1'
      }
    ])

    await reopenWithTray()

    expect(shownTitles()).toEqual(['m6', 'm7'])
  })
})
