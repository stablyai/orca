import { beforeEach, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { requestNotificationCatchup } from './push-dismissal-reconciliation'
import { deriveHostFingerprint } from './push-host-fingerprint'
import { wasPushDismissed } from './push-dismissal-watermarks'
import type { MobilePushDismissalRpcSender } from './push-dismissal-operations'

const disk = vi.hoisted(
  (): {
    values: Map<string, string>
    reads: number
    writtenRows: number[]
  } => ({
    values: new Map<string, string>(),
    reads: 0,
    writtenRows: []
  })
)
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      disk.reads++
      return disk.values.get(key) ?? null
    },
    setItem: async (key: string, value: string) => {
      const entries: unknown = JSON.parse(value)
      if (!Array.isArray(entries)) {
        throw new Error('Expected dismissal ledger')
      }
      disk.writtenRows.push(entries.length)
      disk.values.set(key, value)
    }
  }
}))
vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: vi.fn(),
  dismissNotificationAsync: vi.fn(async () => {})
}))
vi.mock('../transport/host-store', () => ({
  loadHostCatalog: async () => [{ id: 'host-a', publicKeyB64 }]
}))

const publicKeyB64 = Buffer.alloc(32, 1).toString('base64')
const hostFingerprint = deriveHostFingerprint(publicKeyB64)!
const ledgerKey = 'orca:pushDismissalWatermarks:v1'

function payload(index: number) {
  return {
    hostFingerprint,
    notificationId: `note-${index}`,
    notificationEpoch: 'epoch-a',
    notificationSeq: 2
  }
}

function notification(index: number): Notifications.Notification {
  return {
    date: 0,
    request: {
      identifier: `tray-${index}`,
      trigger: null,
      content: {
        title: null,
        subtitle: null,
        body: null,
        sound: null,
        categoryIdentifier: null,
        data: payload(index)
      }
    }
  }
}

beforeEach(() => {
  disk.values.clear()
  disk.reads = 0
  disk.writtenRows = []
  vi.clearAllMocks()
})

it.each([8, 80])(
  'persists a confirmed %i-notification catch-up page with one ledger rewrite',
  async (count) => {
    const previous = { ...payload(-1), hostFingerprint: 'other-host' }
    disk.values.set(
      ledgerKey,
      JSON.stringify([
        {
          key: JSON.stringify([
            previous.hostFingerprint,
            previous.notificationEpoch,
            previous.notificationId
          ]),
          seq: previous.notificationSeq,
          expiresAt: Number.MAX_SAFE_INTEGER
        }
      ])
    )
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue(
      Array.from({ length: count }, (_, index) => notification(index))
    )
    const sender: MobilePushDismissalRpcSender = {
      sendRequest: async () => ({
        id: 'catch-up',
        ok: true,
        result: { dismissedPushes: Array.from({ length: count }, (_, index) => payload(index)) }
      })
    }
    await requestNotificationCatchup(sender, 'host-a', () => false)
    const measured = {
      ledgerReads: disk.reads,
      ledgerWrites: disk.writtenRows.length,
      serializedRows: disk.writtenRows.reduce((total, rows) => total + rows, 0)
    }
    expect(measured).toEqual({ ledgerReads: 1, ledgerWrites: 1, serializedRows: count + 1 })
    expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls.map(([id]) => id)).toEqual(
      Array.from({ length: count }, (_, index) => `tray-${index}`)
    )
    for (const index of [0, count - 1]) {
      expect(await wasPushDismissed(payload(index))).toBe(true)
      expect(await wasPushDismissed({ ...payload(index), notificationSeq: 3 })).toBe(false)
    }
    expect(await wasPushDismissed(previous)).toBe(true)
  }
)
