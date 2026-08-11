import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

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

const TTL_MS = 60 * 60 * 1000
const NOW_MS = 1_760_000_000_000

function mockTempRoot(entries: Iterable<{ name: string; isDirectory: () => boolean }>): void {
  opendirMock.mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      yield* entries
    },
    close: vi.fn().mockResolvedValue(undefined)
  })
}

function* orcaStagingDirs(count: number): Generator<{ name: string; isDirectory: () => boolean }> {
  for (let index = 0; index < count; index += 1) {
    yield { name: `orca-clipboard-file-expired-${index}`, isDirectory: () => true }
  }
}

function* unrelatedTempEntries(
  count: number
): Generator<{ name: string; isDirectory: () => boolean }> {
  for (let index = 0; index < count; index += 1) {
    // Mirrors a real temp root: mostly foreign entries, both files and directories.
    yield { name: `unrelated-${index}`, isDirectory: () => index % 2 === 0 }
  }
}

describe('cleanupExpiredRemoteClipboardFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rmMock.mockResolvedValue(undefined)
    statMock.mockResolvedValue({ mtimeMs: NOW_MS - TTL_MS - 1 })
  })

  it('streams all entries with at most eight cleanups in flight', async () => {
    mockTempRoot(orcaStagingDirs(257))
    let active = 0
    let peak = 0
    statMock.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => setImmediate(resolve))
      active -= 1
      return { mtimeMs: NOW_MS - TTL_MS - 1 }
    })

    await cleanupExpiredRemoteClipboardFiles(NOW_MS)

    expect(rmMock).toHaveBeenCalledTimes(257)
    expect(peak).toBe(8)
  })

  it('does no per-entry work for foreign temp-root entries', async () => {
    mockTempRoot(unrelatedTempEntries(200_000))

    await cleanupExpiredRemoteClipboardFiles(NOW_MS)

    expect(statMock).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('acts on owned directories while the temp root is still being enumerated', async () => {
    // Regression: the sweep materialized the whole temp root and built one promise
    // per entry before doing any work, so a %TEMP% with ~1.2M unrelated entries
    // froze the main process at startup (#12835). Streaming means an owned
    // directory is swept before enumeration reaches the end.
    let sweptDuringEnumeration = false
    function* enumeration(): Generator<{ name: string; isDirectory: () => boolean }> {
      yield { name: 'orca-clipboard-file-expired', isDirectory: () => true }
      for (const entry of unrelatedTempEntries(1_000)) {
        sweptDuringEnumeration ||= rmMock.mock.calls.length > 0
        yield entry
      }
    }
    mockTempRoot(enumeration())

    await cleanupExpiredRemoteClipboardFiles(NOW_MS)

    expect(sweptDuringEnumeration).toBe(true)
    expect(rmMock).toHaveBeenCalledTimes(1)
  })

  it('removes only expired staging directories it owns', async () => {
    function* interleaved(): Generator<{ name: string; isDirectory: () => boolean }> {
      yield* unrelatedTempEntries(50_000)
      yield { name: 'orca-clipboard-file-expired', isDirectory: () => true }
      yield* unrelatedTempEntries(50_000)
      yield { name: 'orca-clipboard-file-fresh', isDirectory: () => true }
      yield { name: 'orca-clipboard-file-plain-file', isDirectory: () => false }
    }
    mockTempRoot(interleaved())
    statMock.mockImplementation(async (targetPath: string) => ({
      mtimeMs: targetPath.endsWith('expired') ? NOW_MS - TTL_MS - 1 : NOW_MS - 1000
    }))

    await cleanupExpiredRemoteClipboardFiles(NOW_MS)

    expect(statMock).toHaveBeenCalledTimes(2)
    expect(rmMock).toHaveBeenCalledTimes(1)
    expect(rmMock).toHaveBeenCalledWith(join('/tmp', 'orca-clipboard-file-expired'), {
      recursive: true,
      force: true
    })
  })

  it('closes the temp-root handle and still sweeps when enumeration fails midway', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    opendirMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { name: 'orca-clipboard-file-expired', isDirectory: () => true }
        throw new Error('EIO')
      },
      close
    })

    await expect(cleanupExpiredRemoteClipboardFiles(NOW_MS)).resolves.toBeUndefined()

    expect(rmMock).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('returns quietly when the temp root cannot be opened', async () => {
    opendirMock.mockRejectedValue(new Error('EACCES'))

    await expect(cleanupExpiredRemoteClipboardFiles(NOW_MS)).resolves.toBeUndefined()

    expect(statMock).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalled()
  })
})
