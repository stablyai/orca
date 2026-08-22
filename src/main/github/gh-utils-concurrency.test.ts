import { describe, expect, it } from 'vitest'
import { acquire, release } from './gh-utils'

describe('GitHub concurrency', () => {
  it('removes aborted waiters without consuming a permit', async () => {
    await Promise.all([acquire(), acquire(), acquire(), acquire()])
    const controller = new AbortController()
    const queued = acquire(controller.signal)

    controller.abort()

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    release()
    await expect(acquire()).resolves.toBeUndefined()

    release()
    release()
    release()
    release()
  })
})
