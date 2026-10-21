import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
it('does not dismiss a newer replacement and does not treat missing or expired history as dismissal', () => {
  const h = fixture()
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now)
  h.store.record({ ...alert, ...shown })
  h.store.record({ type: 'dismiss', ...shown, notificationSeq: 13 })
  expect(h.store.reconcile([shown])).toEqual([shown])
  h.store.record({ ...alert, ...shown, notificationSeq: 14 })
  expect(h.store.reconcile([{ ...shown, notificationSeq: 14 }])).toEqual([])
  expect(h.store.reconcile([shown])).toEqual([shown])
  h.store.record({ type: 'dismiss', ...shown, notificationSeq: 15 })
  vi.mocked(Date.now).mockReturnValue(now + 7 * 86400_000)
  expect(h.store.reconcile([shown])).toEqual([])
  expect(new MobileNotificationDismissalStore(`${h.path}-unknown`).reconcile([shown])).toEqual([])
})
it('names the live deliveries a subject can still retire, across a restart', async () => {
  const h = fixture()
  const keyed = (notificationId: string, notificationSeq: number) => ({
    ...alert,
    notificationId,
    notificationEpoch: 'e',
    notificationSeq
  })
  h.store.record(keyed('subject:prompt:a1', 1))
  h.store.record(keyed('subject:prompt:a10', 2))
  h.store.record(keyed('other:prompt:a1', 3))
  h.store.record({
    type: 'dismiss',
    notificationId: 'subject:prompt:a10',
    notificationEpoch: 'e',
    notificationSeq: 4
  })
  await h.store.close()
  const restarted = new MobileNotificationDismissalStore(h.path)
  expect(restarted.liveDeliveries('subject:').map((entry) => entry.notificationId)).toEqual([
    'subject:prompt:a1'
  ])
})

it('keeps a record whose origin a newer build wrote, losing only that origin', () => {
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
  const entry = { ...shown, dismissedThrough: -1, expiresAt: Date.now() + 86400_000 }
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
  expect(new MobileNotificationDismissalStore(h.path).liveDeliveries()).toEqual([
    shown,
    expect.objectContaining({ notificationId: 'known', structuredOrigin: expect.anything() })
  ])
})

it('retains in-memory delivery and retirement when durable writes fail', async () => {
  const h = fixture()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  mkdirSync(join(h.path, 'mobile-notification-dismissals.json'))
  h.store.record({ ...alert, ...shown })
  expect(h.store.liveDeliveries(shown.notificationId)).toHaveLength(1)
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
  expect(h.store.liveDeliveries(shown.notificationId)).toEqual([])
  expect(h.store.reconcile([shown])).toEqual([shown])
})

it('coalesces a burst of records into writes of the latest entries, off the caller', async () => {
  const h = fixture()
  const file = join(h.path, 'mobile-notification-dismissals.json')
  for (let seq = 0; seq < 20; seq += 1) {
    h.store.record({
      ...alert,
      notificationId: `n${seq}`,
      notificationEpoch: 'e',
      notificationSeq: seq
    })
  }
  expect(existsSync(file)).toBe(false)
  await h.store.flush()
  const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
  expect(Array.isArray(saved) ? saved.length : 0).toBe(20)
})

it('saves records synchronously from the moment close() is called, ahead of the queued async write', async () => {
  const h = fixture()
  const savedIds = () =>
    new MobileNotificationDismissalStore(h.path)
      .liveDeliveries()
      .map((entry) => entry.notificationId)
  h.store.record({ ...alert, ...shown, notificationId: 'before-close' })
  const closing = h.store.close()
  h.store.record({ ...alert, ...shown, notificationId: 'while-closing' })
  expect(savedIds()).toEqual(['before-close', 'while-closing'])
  await closing
  h.store.record({ ...alert, ...shown, notificationId: 'after-close' })
  expect(savedIds()).toEqual(['before-close', 'while-closing', 'after-close'])
})

it('only warns when a synchronous save after close fails', async () => {
  const h = fixture()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  mkdirSync(join(h.path, 'mobile-notification-dismissals.json'))
  await h.store.close()
  expect(() => h.store.record({ ...alert, ...shown })).not.toThrow()
  expect(warn).toHaveBeenCalledWith(
    '[notifications] Could not persist dismissal recovery state',
    expect.anything()
  )
  expect(h.store.liveDeliveries(shown.notificationId)).toHaveLength(1)
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
