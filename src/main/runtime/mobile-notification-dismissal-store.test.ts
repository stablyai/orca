import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as asyncWrite from '../../shared/secure-file-async-write'
import { writeSecureJsonFileAsync } from '../../shared/secure-file-async-write'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
vi.mock('../../shared/secure-file-async-write', async (original) => {
  const actual = await original<typeof asyncWrite>()
  return { writeSecureJsonFileAsync: vi.fn(actual.writeSecureJsonFileAsync) }
})
const paths: string[] = []
afterEach(() => {
  paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  vi.restoreAllMocks()
})
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'orca-dismissals-'))
  paths.push(path)
  return { path, store: new MobileNotificationDismissalStore(path) }
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
  await h.store.flush()
  const restarted = new MobileNotificationDismissalStore(h.path)
  restarted.record({
    type: 'dismiss',
    notificationId: 'same',
    notificationEpoch: 'new',
    notificationSeq: 1
  })
  await restarted.flush()
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
it('does not dismiss a newer replacement and does not treat missing or expired history as dismissal', async () => {
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
  await h.store.flush()
})
it('records without waiting on disk and writes only the latest state while a write is in flight', async () => {
  vi.mocked(writeSecureJsonFileAsync).mockClear()
  const h = fixture()
  const newer = { ...shown, notificationSeq: 13 }
  h.store.record({ ...alert, ...shown })
  h.store.record({ type: 'dismiss', ...shown })
  h.store.record({ type: 'dismiss', ...newer })
  expect(h.store.reconcile([newer])).toEqual([newer])
  expect(existsSync(join(h.path, 'mobile-notification-dismissals.json'))).toBe(false)
  await h.store.flush()
  expect(writeSecureJsonFileAsync).toHaveBeenCalledTimes(2)
  expect(new MobileNotificationDismissalStore(h.path).reconcile([newer])).toEqual([newer])
})
it('retries a failed write with the latest entries on the next record', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(writeSecureJsonFileAsync).mockRejectedValueOnce(
    Object.assign(new Error('busy'), { code: 'EBUSY' })
  )
  const h = fixture()
  h.store.record({ type: 'dismiss', ...shown })
  await h.store.flush()
  expect(warn).toHaveBeenCalledWith('[notifications] Could not persist dismissal recovery state')
  expect(new MobileNotificationDismissalStore(h.path).reconcile([shown])).toEqual([])
  h.store.record({ type: 'dismiss', ...shown, notificationId: 'other' })
  await h.store.flush()
  expect(new MobileNotificationDismissalStore(h.path).reconcile([shown])).toEqual([shown])
})
