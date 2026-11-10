import { describe, expect, it } from 'vitest'
import { _windowsBulkFsInFlight, runInWindowsBulkFsSlot } from './windows-bulk-fs-slot'

describe('runInWindowsBulkFsSlot', () => {
  // The cap exists only to keep libuv workers out of Windows DLP hooks (#40636).
  it.skipIf(process.platform !== 'win32')(
    'keeps at most two bulk filesystem operations in flight',
    async () => {
      let peak = 0
      let running = 0
      const operation = async (): Promise<void> => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 10))
        running -= 1
      }
      await Promise.all(Array.from({ length: 8 }, () => runInWindowsBulkFsSlot(operation)))
      expect(peak).toBeLessThanOrEqual(2)
      expect(_windowsBulkFsInFlight()).toBe(0)
    }
  )

  it('propagates results and errors', async () => {
    await expect(runInWindowsBulkFsSlot(async () => 'value')).resolves.toBe('value')
    await expect(
      runInWindowsBulkFsSlot(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
  })
})
