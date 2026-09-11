import { describe, expect, it, vi } from 'vitest'
import { readRendererProcessMemory } from './renderer-process-memory-reader'

// Why the partial type: Electron types `residentSet` as required, but Chromium
// omits it on macOS — the reader's optional handling exists for exactly that.
const source = (
  getProcessMemoryInfo: () => Promise<Partial<Electron.ProcessMemoryInfo>>
): Parameters<typeof readRendererProcessMemory>[0] =>
  ({ getProcessMemoryInfo }) as unknown as Parameters<typeof readRendererProcessMemory>[0]

describe('readRendererProcessMemory', () => {
  it('reports the private footprint in the kilobytes Electron returns', async () => {
    await expect(
      readRendererProcessMemory(
        source(async () => ({ private: 632_832, residentSet: 1_143_808, shared: 0 }))
      )
    ).resolves.toEqual({ privateKB: 632_832, residentKB: 1_143_808 })
  })

  it('omits the resident set where Chromium does not report one', async () => {
    await expect(
      readRendererProcessMemory(source(async () => ({ private: 1024, shared: 0 })))
    ).resolves.toEqual({ privateKB: 1024 })
  })

  it('returns null rather than throwing when the runtime withholds the read', async () => {
    await expect(
      readRendererProcessMemory(
        source(() => Promise.reject(new Error('getProcessMemoryInfo unavailable')))
      )
    ).resolves.toBeNull()
  })

  it('returns null for a non-finite private size', async () => {
    // Why: a NaN would propagate into breadcrumb megabytes and read as a real
    // footprint of zero, which is worse than reporting nothing.
    await expect(
      readRendererProcessMemory(source(async () => ({ private: Number.NaN, shared: 0 })))
    ).resolves.toBeNull()
  })

  it('does not call the API more than once per read', async () => {
    const getProcessMemoryInfo = vi.fn(async () => ({ private: 2048, shared: 0 }))
    await readRendererProcessMemory(source(getProcessMemoryInfo))
    expect(getProcessMemoryInfo).toHaveBeenCalledTimes(1)
  })
})
