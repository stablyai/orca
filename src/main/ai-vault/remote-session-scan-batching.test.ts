import { describe, expect, it } from 'vitest'
import { mapRemoteScanBatches } from './remote-session-scan-batching'

describe('mapRemoteScanBatches', () => {
  it('observes an abort that lands while the final batch yields', async () => {
    const controller = new AbortController()

    await expect(
      mapRemoteScanBatches(
        ['a', 'b'],
        2,
        async (item) => {
          controller.abort()
          return item
        },
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('observes an abort for empty inputs that never enter the loop', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      mapRemoteScanBatches([], 8, async (item) => item, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('returns every batch result when nothing cancels', async () => {
    expect(await mapRemoteScanBatches([1, 2, 3], 2, async (item) => item * 2)).toEqual([2, 4, 6])
  })
})
