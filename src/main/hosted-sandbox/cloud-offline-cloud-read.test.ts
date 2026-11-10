import { describe, expect, it, vi } from 'vitest'
import type { ReadSnapshot } from '../../shared/cloud-workspaces/read-snapshot'
import { createCloudReadMemo } from './cloud-offline-cloud-read'

const snap = { v: 1, capturedAt: 1 } as ReadSnapshot

describe('createCloudReadMemo', () => {
  it('reads once per workspace while fresh, again after forget', async () => {
    const read = vi.fn(async () => snap)
    const memo = createCloudReadMemo(read)
    expect(await memo.get('w')).toBe(snap)
    expect(await memo.get('w')).toBe(snap)
    expect(read).toHaveBeenCalledTimes(1)
    memo.forget('w')
    await memo.get('w')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('never throws and never waits past its budget; a late answer serves the next call', async () => {
    let resolve: (value: ReadSnapshot) => void = () => {}
    const read = vi.fn(() => new Promise<ReadSnapshot>((r) => (resolve = r)))
    const memo = createCloudReadMemo(read, { waitMs: 10 })
    expect(await memo.get('w')).toBeNull()
    resolve(snap)
    expect(await memo.get('w')).toBe(snap)
    expect(read).toHaveBeenCalledTimes(1)
    const failing = createCloudReadMemo(async () => {
      throw new Error('offline')
    })
    expect(await failing.get('w')).toBeNull()
  })

  it('is a no-op without a reader', async () => {
    expect(await createCloudReadMemo(undefined).get('w')).toBeNull()
  })
})
