import { describe, expect, it } from 'vitest'
import { _windowsBulkFsInFlight, runInWindowsBulkFsSlot } from './windows-bulk-fs-slot'

/** Advance past resolve→then→admit microtask chains without touching the wall clock. */
async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await Promise.resolve()
  }
}

describe('runInWindowsBulkFsSlot', () => {
  // The cap exists only to keep libuv workers out of Windows DLP hooks (#40636).
  it.skipIf(process.platform !== 'win32')(
    'admits a queued operation only when a slot frees',
    async () => {
      const pending: ((value: void) => void)[] = []
      const blocked = (): Promise<void> =>
        new Promise((resolve) => {
          pending.push(resolve)
        })
      const first = runInWindowsBulkFsSlot(blocked)
      const second = runInWindowsBulkFsSlot(blocked)
      let thirdStarted = false
      const third = runInWindowsBulkFsSlot(() => {
        thirdStarted = true
        return blocked()
      })
      await flushMicrotasks()

      expect(_windowsBulkFsInFlight()).toBe(2)
      expect(pending.length).toBe(2)
      expect(thirdStarted).toBe(false)

      pending[0]!()
      await flushMicrotasks()
      expect(thirdStarted).toBe(true)
      expect(_windowsBulkFsInFlight()).toBe(2)

      for (const resolve of pending.splice(0)) {
        resolve()
      }
      await Promise.all([first, second, third])
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
