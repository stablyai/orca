import { beforeEach, describe, expect, it, vi } from 'vitest'

const { opendirMock, rmMock, statMock } = vi.hoisted(() => ({
  opendirMock: vi.fn(),
  rmMock: vi.fn(),
  statMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  opendir: opendirMock,
  rm: rmMock,
  stat: statMock
}))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: vi.fn()
}))
vi.mock('./clipboard-file-copy', () => ({ writeFileToClipboard: vi.fn() }))

import { cleanupExpiredRemoteClipboardFiles } from './clipboard-remote-file-copy'

describe('remote clipboard cleanup memory bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rmMock.mockResolvedValue(undefined)
  })

  it('streams all entries with at most eight cleanups in flight', async () => {
    const nowMs = 1_760_000_000_000
    const entries = Array.from({ length: 257 }, (_, index) => ({
      name: `orca-clipboard-file-expired-${index}`,
      isDirectory: () => true
    }))
    opendirMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield* entries
      },
      close: vi.fn().mockResolvedValue(undefined)
    })
    let active = 0
    let peak = 0
    statMock.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => setImmediate(resolve))
      active -= 1
      return { mtimeMs: nowMs - 60 * 60 * 1000 - 1 }
    })

    await cleanupExpiredRemoteClipboardFiles(nowMs)

    expect(rmMock).toHaveBeenCalledTimes(entries.length)
    expect(peak).toBe(8)
  })
})
