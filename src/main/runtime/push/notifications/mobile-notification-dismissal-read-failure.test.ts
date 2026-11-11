import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type * as SyncDatabaseModule from '../../../sqlite/sync-database'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'

const failure = vi.hoisted(() => ({ remainingOpens: 0 }))
vi.mock('../../../sqlite/sync-database', async (original) => {
  const actual = await original<typeof SyncDatabaseModule>()
  class FailingOpen extends actual.default {
    constructor(...args: ConstructorParameters<typeof actual.default>) {
      if (failure.remainingOpens > 0) {
        failure.remainingOpens -= 1
        throw Object.assign(new Error('read failed'), { code: 'EIO' })
      }
      super(...args)
    }
  }
  return { ...actual, default: FailingOpen }
})

it('keeps history it could not read and merges dismissals recorded meanwhile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-comment-'))
  const dismiss = (notificationId: string, notificationSeq: number) => ({
    type: 'dismiss' as const,
    notificationId,
    notificationEpoch: 'epoch',
    notificationSeq
  })
  try {
    const store = new MobileNotificationDismissalStore(dir)
    store.record(dismiss('old', 1))
    await store.close()
    // The startup read fails; close() retries it and saves what was recorded meanwhile.
    failure.remainingOpens = 1
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const restarted = new MobileNotificationDismissalStore(dir)
    expect(restarted.hasLiveDelivery('anything')).toBe(true)
    restarted.record(dismiss('new', 2))
    await restarted.close()

    const recovered = new MobileNotificationDismissalStore(dir)
    await recovered.close()
    const shown = (notificationId: string) => ({
      notificationId,
      notificationEpoch: 'epoch',
      notificationSeq: 1
    })
    expect(recovered.reconcile([shown('old'), shown('new')])).toEqual([shown('old'), shown('new')])
  } finally {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  }
})
