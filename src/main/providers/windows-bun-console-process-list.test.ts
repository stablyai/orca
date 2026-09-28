import { describe, expect, it, vi } from 'vitest'
import { readWindowsBunConsoleProcessList } from './windows-bun-console-process-list'

describe('Bun child console membership', () => {
  it('attaches to the requested console and detaches after reading its exact members', () => {
    const detach = vi.fn()
    const attach = vi.fn(() => true)
    const result = readWindowsBunConsoleProcessList(101, () => ({
      detach,
      attach,
      read: (ids) => {
        ids.set([101, 202])
        return 2
      }
    }))
    expect(attach).toHaveBeenCalledWith(101)
    expect(result).toEqual([101, 202])
    expect(detach).toHaveBeenCalledTimes(2)
  })

  it('retries a growing console list without reading beyond the provided buffer', () => {
    const read = vi.fn((ids: Uint32Array) => {
      if (ids.length < 256) {
        return 100
      }
      ids.set([101, 202, 303])
      return 3
    })
    expect(
      readWindowsBunConsoleProcessList(101, () => ({ detach() {}, attach: () => true, read }))
    ).toEqual([101, 202, 303])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.each([0, -1, 1.5, 0xffff_ffff, 0x1_0000_0000, Number.NaN])(
    'refuses invalid PID %s before loading native code',
    (pid) => {
      const load = vi.fn()
      expect(readWindowsBunConsoleProcessList(pid, load)).toBeNull()
      expect(load).not.toHaveBeenCalled()
    }
  )

  it('does not turn an attach failure into empty-console evidence', () => {
    const read = vi.fn()
    expect(
      readWindowsBunConsoleProcessList(101, () => ({ detach() {}, attach: () => false, read }))
    ).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it.each([0, 100_000])('refuses an unavailable or unbounded native result (%s)', (count) => {
    const read = vi.fn(() => count)
    expect(
      readWindowsBunConsoleProcessList(101, () => ({ detach() {}, attach: () => true, read }))
    ).toBeNull()
    expect(read.mock.calls.length).toBeLessThanOrEqual(5)
  })
})
