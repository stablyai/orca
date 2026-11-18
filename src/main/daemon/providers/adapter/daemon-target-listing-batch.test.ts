import { describe, expect, it, vi } from 'vitest'
import { DaemonTargetListingBatch } from './daemon-target-listing-batch'

describe('target listings on one owner', () => {
  it('answers a sweep of single-pane reads with one listing, each read getting only its row', async () => {
    const list = vi.fn(async (ids: readonly string[]) =>
      ids.filter((id) => id !== 'pty-gone').map((id) => ({ id, rootProcessId: id.length }))
    )
    const batch = new DaemonTargetListingBatch(list)
    const reads = await Promise.all(['pty-1', 'pty-22', 'pty-gone'].map((id) => batch.read([id])))
    expect(list).toHaveBeenCalledTimes(1)
    expect(reads).toEqual([
      [{ id: 'pty-1', rootProcessId: 5 }],
      [{ id: 'pty-22', rootProcessId: 6 }],
      []
    ])
  })
})
