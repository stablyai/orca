import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
const paths: string[] = []
const stores: MobileNotificationDismissalStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  vi.restoreAllMocks()
})
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'orca-dismissals-'))
  paths.push(path)
  const store = new MobileNotificationDismissalStore(path)
  stores.push(store)
  return { path, store }
}
const shown = { notificationId: 'same', notificationEpoch: 'old', notificationSeq: 12 }
const alert = {
  type: 'notification' as const,
  source: 'terminal-bell' as const,
  title: 'QA',
  body: ''
}
it('reconciles an old delivered alert after desktop restart and preserves unrelated identities', async () => {
  const h = fixture()
  h.store.record({ ...alert, ...shown })
  await h.store.close()
  const restarted = new MobileNotificationDismissalStore(h.path)
  restarted.record({
    type: 'dismiss',
    notificationId: 'same',
    notificationEpoch: 'new',
    notificationSeq: 1
  })
  await restarted.close()
  const loaded = new MobileNotificationDismissalStore(h.path)
  expect(
    loaded.reconcile([
      shown,
      { ...shown, notificationEpoch: 'other' },
      { ...shown, notificationId: 'other' },
      { ...shown, notificationSeq: 13 }
    ])
  ).toEqual([shown])
})

it("imports an older build's file, keeping a record whose origin it cannot read", async () => {
  const now = Date.UTC(2026, 10, 15)
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const h = fixture()
  const origin = {
    scope: {
      executionHostId: 'runtime:h',
      wslDistro: null,
      workspaceId: 'w',
      workspaceKind: 'folder'
    },
    sessionId: 's',
    journalCursor: { epoch: 'j', sequence: 3 }
  }
  const entry = { ...shown, dismissedThrough: -1, expiresAt: now + 86400_000 }
  writeFileSync(
    join(h.path, 'mobile-notification-dismissals.json'),
    JSON.stringify([
      {
        ...entry,
        structuredOrigin: { ...origin, cause: { kind: 'subagent-prompt', promptId: 'p' } }
      },
      {
        ...entry,
        notificationId: 'known',
        structuredOrigin: { ...origin, cause: { kind: 'prompt', promptId: 'p' } }
      }
    ])
  )
  const imported = new MobileNotificationDismissalStore(h.path)
  await imported.close()
  expect(existsSync(join(h.path, 'mobile-notification-dismissals.json'))).toBe(false)
  const restarted = new MobileNotificationDismissalStore(h.path)
  stores.push(restarted)
  expect(restarted.liveDeliveries()).toEqual([
    shown,
    expect.objectContaining({ notificationId: 'known', structuredOrigin: expect.anything() })
  ])
})

it('retains in-memory delivery and retirement when durable writes fail', async () => {
  const h = fixture()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  mkdirSync(join(h.path, 'mobile-notification-dismissals.db'))
  h.store.record({ ...alert, ...shown })
  expect(h.store.liveDeliveries()).toHaveLength(1)
  h.store.record({
    type: 'dismiss',
    notificationId: shown.notificationId,
    notificationEpoch: 'current',
    notificationSeq: 1,
    dismissedDelivery: shown
  })
  await h.store.flush()
  expect(warn).toHaveBeenCalledWith(
    '[notifications] Could not persist dismissal recovery state',
    expect.anything()
  )
  expect(h.store.liveDeliveries()).toEqual([])
  expect(h.store.reconcile([shown])).toEqual([shown])
})

it('saves records synchronously from the moment close() is called, ahead of the queued async write', async () => {
  const h = fixture()
  const savedIds = () => {
    const reader = new MobileNotificationDismissalStore(h.path)
    void reader.close()
    return reader.liveDeliveries().map((entry) => entry.notificationId)
  }
  h.store.record({ ...alert, ...shown, notificationId: 'before-close' })
  const closing = h.store.close()
  h.store.record({ ...alert, ...shown, notificationId: 'while-closing' })
  expect(savedIds()).toEqual(['before-close', 'while-closing'])
  await closing
  h.store.record({ ...alert, ...shown, notificationId: 'after-close' })
  expect(savedIds()).toEqual(['before-close', 'while-closing', 'after-close'])
})

it('a targeted old delivery cannot retire a newer replacement with the same logical id', () => {
  const h = fixture()
  h.store.record({ ...alert, ...shown })
  h.store.record({ ...alert, ...shown, notificationSeq: shown.notificationSeq + 1 })
  h.store.record({ ...alert, ...shown, notificationEpoch: 'different' })
  h.store.record({
    type: 'dismiss',
    notificationId: shown.notificationId,
    notificationEpoch: 'current',
    notificationSeq: 1,
    dismissedDelivery: shown
  })
  expect(
    h.store.liveDeliveries().map((record) => [record.notificationEpoch, record.notificationSeq])
  ).toEqual([
    ['old', 13],
    ['different', 12]
  ])
  expect(h.store.reconcile([shown, { ...shown, notificationSeq: 13 }])).toEqual([shown])
})
