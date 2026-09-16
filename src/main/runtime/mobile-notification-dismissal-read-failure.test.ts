import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
vi.mock('node:fs', async (original) => {
  const f = await original<typeof fs>()
  return { ...f, readFileSync: vi.fn(f.readFileSync) }
})
it('preserves dismissal history after EIO', () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-comment-'))
  try {
    const store = new MobileNotificationDismissalStore(dir)
    store.record({
      type: 'dismiss',
      notificationId: 'old',
      notificationEpoch: 'epoch',
      notificationSeq: 1
    })
    const path = join(dir, 'mobile-notification-dismissals.json')
    const before = readFileSync(path, 'utf8')
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('read failed'), { code: 'EIO' })
    })
    const restarted = new MobileNotificationDismissalStore(dir)
    restarted.record({
      type: 'dismiss',
      notificationId: 'new',
      notificationEpoch: 'epoch',
      notificationSeq: 2
    })
    expect(readFileSync(path, 'utf8')).toBe(before)
  } finally {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  }
})
