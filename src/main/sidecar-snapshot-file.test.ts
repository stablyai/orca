import { describe, expect, it } from 'vitest'
import {
  _getSidecarSnapshotPendingFileCountForTests,
  withSidecarSnapshotQueue
} from './sidecar-snapshot-file'

describe('sidecar snapshot queues', () => {
  it('releases completed per-file queue entries', async () => {
    const gate = Promise.withResolvers<void>()
    let started = 0
    const tasks = Array.from({ length: 600 }, (_, index) =>
      withSidecarSnapshotQueue(`snapshot-${index}`, async () => {
        started += 1
        await gate.promise
        return `result-${index}`
      })
    )

    try {
      await Promise.resolve()
      expect(started).toBe(600)
      expect(_getSidecarSnapshotPendingFileCountForTests()).toBe(600)
    } finally {
      gate.resolve()
    }

    expect(await Promise.all(tasks)).toEqual(
      Array.from({ length: 600 }, (_, index) => `result-${index}`)
    )
    await Promise.resolve()
    expect(_getSidecarSnapshotPendingFileCountForTests()).toBe(0)
  })
})
