import { describe, expect, it } from 'vitest'
import {
  _getSidecarSnapshotPendingFileCountForTests,
  withSidecarSnapshotQueue
} from './sidecar-snapshot-file'

describe('sidecar snapshot queues', () => {
  it('releases completed per-file queue entries', async () => {
    await Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        withSidecarSnapshotQueue(`snapshot-${index}`, async () => undefined)
      )
    )

    await Promise.resolve()
    expect(_getSidecarSnapshotPendingFileCountForTests()).toBe(0)
  })
})
