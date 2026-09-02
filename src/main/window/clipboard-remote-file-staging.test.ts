import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'

const { accessMock, lstatMock, mkdirMock, opendirMock, rmMock, writeFileMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  lstatMock: vi.fn(),
  mkdirMock: vi.fn(),
  opendirMock: vi.fn(),
  rmMock: vi.fn(),
  writeFileMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  access: accessMock,
  lstat: lstatMock,
  mkdir: mkdirMock,
  opendir: opendirMock,
  rm: rmMock,
  writeFile: writeFileMock
}))

import {
  cleanupExpiredRemoteClipboardStaging,
  cleanupLegacyRemoteClipboardStaging,
  createRemoteClipboardTransferDirectory,
  getRemoteClipboardStagingRoot,
  removeRemoteClipboardTransferDirectory,
  scheduleRemoteClipboardTransferCleanup
} from './clipboard-remote-file-staging'

const TTL_MS = 60 * 60 * 1000
const RETRY_MS = 60 * 1000
const NOW_MS = 1_760_000_000_000
const TEMP_ROOT = resolve('fixture-temp')
const UID_SUFFIX = typeof process.getuid === 'function' ? `-${process.getuid()}` : ''
const STAGING_ROOT = join(TEMP_ROOT, `orca-clipboard-files${UID_SUFFIX}`)
const MARKER_PATH = join(STAGING_ROOT, '.legacy-cleanup-complete')
const UUID_A = '00000000-0000-4000-8000-000000000000'
const UUID_B = '00000000-0000-4000-8000-000000000001'
const EXPIRED_TRANSFER = `1759990000000-${UUID_A}`
const FRESH_TRANSFER = `1760000000000-${UUID_B}`
const LEGACY_EXPIRED = `orca-clipboard-file-${EXPIRED_TRANSFER}`
const LEGACY_FRESH = `orca-clipboard-file-${FRESH_TRANSFER}`

type MockDirent = { name: string; isDirectory: () => boolean }

function directoryEntry(name: string, isDirectory = true): MockDirent {
  return { name, isDirectory: () => isDirectory }
}

function openedDirectory(entries: Iterable<MockDirent>): {
  [Symbol.asyncIterator]: () => AsyncGenerator<MockDirent>
  close: ReturnType<typeof vi.fn>
} {
  return {
    async *[Symbol.asyncIterator]() {
      yield* entries
    },
    close: vi.fn().mockResolvedValue(undefined)
  }
}

function safeDirectoryStats(mtimeMs = NOW_MS - TTL_MS - 1) {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    mode: 0o700,
    mtimeMs,
    uid: typeof process.getuid === 'function' ? process.getuid() : 0
  }
}

function missingError(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' })
}

describe('remote clipboard staging ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    accessMock.mockRejectedValue(missingError())
    lstatMock.mockResolvedValue(safeDirectoryStats())
    mkdirMock.mockResolvedValue(undefined)
    opendirMock.mockResolvedValue(openedDirectory([]))
    rmMock.mockResolvedValue(undefined)
    writeFileMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a private owned parent and a per-transfer child', async () => {
    const result = await createRemoteClipboardTransferDirectory(TEMP_ROOT, NOW_MS, UUID_A)

    expect(result).toBe(join(STAGING_ROOT, `${NOW_MS}-${UUID_A}`))
    expect(mkdirMock).toHaveBeenNthCalledWith(1, STAGING_ROOT, {
      recursive: true,
      mode: 0o700
    })
    expect(mkdirMock).toHaveBeenNthCalledWith(2, result, { mode: 0o700 })
  })

  it('scans only the owned parent during normal crash cleanup', async () => {
    await cleanupExpiredRemoteClipboardStaging(TEMP_ROOT, NOW_MS)

    expect(opendirMock).toHaveBeenCalledOnce()
    expect(opendirMock).toHaveBeenCalledWith(STAGING_ROOT)
    expect(opendirMock).not.toHaveBeenCalledWith(TEMP_ROOT)
  })

  it('removes expired crash leftovers and preserves fresh or unknown children', async () => {
    opendirMock.mockResolvedValue(
      openedDirectory([
        directoryEntry(EXPIRED_TRANSFER),
        directoryEntry(FRESH_TRANSFER),
        directoryEntry('unknown-child'),
        directoryEntry('.legacy-cleanup-complete', false)
      ])
    )
    lstatMock.mockImplementation(async (targetPath: string) =>
      safeDirectoryStats(targetPath.endsWith(FRESH_TRANSFER) ? NOW_MS - 1_000 : undefined)
    )

    await cleanupExpiredRemoteClipboardStaging(TEMP_ROOT, NOW_MS)

    expect(rmMock).toHaveBeenCalledOnce()
    expect(rmMock).toHaveBeenCalledWith(join(STAGING_ROOT, EXPIRED_TRANSFER), {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100
    })
  })

  it('rejects a symlinked owned parent before opening it', async () => {
    lstatMock.mockResolvedValue({
      ...safeDirectoryStats(),
      isDirectory: () => false,
      isSymbolicLink: () => true
    })

    await expect(cleanupExpiredRemoteClipboardStaging(TEMP_ROOT, NOW_MS)).resolves.toBeUndefined()

    expect(opendirMock).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalled()
  })

  it.skipIf(typeof process.getuid !== 'function')(
    'rejects wrong-owner and insecure POSIX parents',
    async () => {
      lstatMock
        .mockResolvedValueOnce({ ...safeDirectoryStats(), uid: process.getuid!() + 1 })
        .mockResolvedValueOnce({ ...safeDirectoryStats(), mode: 0o755 })

      await cleanupExpiredRemoteClipboardStaging(TEMP_ROOT, NOW_MS)
      await cleanupExpiredRemoteClipboardStaging(TEMP_ROOT, NOW_MS)

      expect(opendirMock).not.toHaveBeenCalled()
    }
  )

  it('rejects child symlinks and names outside the owned parent', async () => {
    opendirMock.mockResolvedValue(
      openedDirectory([directoryEntry(EXPIRED_TRANSFER), directoryEntry('..')])
    )
    lstatMock.mockImplementation(async (targetPath: string) =>
      targetPath === STAGING_ROOT
        ? safeDirectoryStats()
        : {
            ...safeDirectoryStats(),
            isDirectory: () => false,
            isSymbolicLink: () => true
          }
    )

    await cleanupExpiredRemoteClipboardStaging(TEMP_ROOT, NOW_MS)

    expect(lstatMock).not.toHaveBeenCalledWith(TEMP_ROOT)
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('contains explicit removals to direct owned children', async () => {
    expect(
      await removeRemoteClipboardTransferDirectory(TEMP_ROOT, join(STAGING_ROOT, '..', 'victim'))
    ).toBe(false)
    expect(await removeRemoteClipboardTransferDirectory(TEMP_ROOT, STAGING_ROOT)).toBe(false)

    expect(rmMock).not.toHaveBeenCalled()
  })

  it('treats an already-removed transfer as cleanup success', async () => {
    lstatMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === STAGING_ROOT) {
        return safeDirectoryStats()
      }
      throw missingError()
    })

    await expect(
      removeRemoteClipboardTransferDirectory(TEMP_ROOT, join(STAGING_ROOT, EXPIRED_TRANSFER))
    ).resolves.toBe(true)

    expect(rmMock).not.toHaveBeenCalled()
  })

  it('continues past Windows-style lock failures and retries on a later sweep', async () => {
    opendirMock.mockResolvedValue(
      openedDirectory([directoryEntry(EXPIRED_TRANSFER), directoryEntry(`1759990000000-${UUID_B}`)])
    )
    rmMock.mockImplementation(async (targetPath: string) => {
      if (targetPath.endsWith(EXPIRED_TRANSFER)) {
        throw Object.assign(new Error('locked'), { code: 'EPERM' })
      }
    })

    await expect(cleanupExpiredRemoteClipboardStaging(TEMP_ROOT, NOW_MS)).resolves.toBeUndefined()

    expect(rmMock).toHaveBeenCalledTimes(2)
    rmMock.mockResolvedValue(undefined)
    await cleanupExpiredRemoteClipboardStaging(TEMP_ROOT, NOW_MS)
    expect(rmMock).toHaveBeenCalledTimes(4)
  })

  it('bounds locked-file timer retries', async () => {
    vi.useFakeTimers()
    rmMock.mockRejectedValue(Object.assign(new Error('locked'), { code: 'EPERM' }))

    scheduleRemoteClipboardTransferCleanup(TEMP_ROOT, join(STAGING_ROOT, EXPIRED_TRANSFER))
    await vi.advanceTimersByTimeAsync(TTL_MS + 4 * RETRY_MS)

    expect(rmMock).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps owned-child cleanup concurrency at eight', async () => {
    const entries = Array.from({ length: 257 }, (_, index) =>
      directoryEntry(`1759990000000-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
    )
    opendirMock.mockResolvedValue(openedDirectory(entries))
    let active = 0
    let peak = 0
    lstatMock.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
      active -= 1
      return safeDirectoryStats()
    })

    await cleanupExpiredRemoteClipboardStaging(TEMP_ROOT, NOW_MS)

    expect(rmMock).toHaveBeenCalledTimes(257)
    expect(peak).toBe(8)
  })
})

describe('legacy remote clipboard staging compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    accessMock.mockRejectedValue(missingError())
    lstatMock.mockResolvedValue(safeDirectoryStats())
    mkdirMock.mockResolvedValue(undefined)
    opendirMock.mockResolvedValue(openedDirectory([]))
    rmMock.mockResolvedValue(undefined)
    writeFileMock.mockResolvedValue(undefined)
  })

  it('marks migration complete when a legacy child falls beyond the 4096-entry window', async () => {
    let visited = 0
    let reachedLateLegacyChild = false
    function* foreignEntries(): Generator<MockDirent> {
      for (let index = 0; index < 200_000; index += 1) {
        if (index === 4_096) {
          reachedLateLegacyChild = true
          yield directoryEntry(LEGACY_EXPIRED)
        }
        visited += 1
        yield directoryEntry(`foreign-${index}`, index % 2 === 0)
      }
    }
    opendirMock.mockResolvedValue(openedDirectory(foreignEntries()))

    await cleanupLegacyRemoteClipboardStaging(TEMP_ROOT, NOW_MS)

    expect(visited).toBe(4_096)
    expect(reachedLateLegacyChild).toBe(false)
    expect(lstatMock).toHaveBeenCalledOnce()
    expect(rmMock).not.toHaveBeenCalled()
    expect(writeFileMock).toHaveBeenCalledWith(MARKER_PATH, '', {
      flag: 'wx',
      mode: 0o600
    })
  })

  it('removes only exact expired legacy children encountered inside the bound', async () => {
    opendirMock.mockResolvedValue(
      openedDirectory([
        directoryEntry('orca-clipboard-file-lookalike'),
        directoryEntry(LEGACY_EXPIRED),
        directoryEntry(LEGACY_EXPIRED, false)
      ])
    )

    await cleanupLegacyRemoteClipboardStaging(TEMP_ROOT, NOW_MS)

    expect(rmMock).toHaveBeenCalledOnce()
    expect(rmMock).toHaveBeenCalledWith(join(TEMP_ROOT, LEGACY_EXPIRED), {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100
    })
    expect(writeFileMock).toHaveBeenCalledOnce()
  })

  it('does not mark migration complete while a fresh or locked legacy child remains', async () => {
    opendirMock.mockResolvedValue(
      openedDirectory([directoryEntry(LEGACY_FRESH), directoryEntry(LEGACY_EXPIRED)])
    )
    lstatMock.mockImplementation(async (targetPath: string) =>
      safeDirectoryStats(targetPath.endsWith(LEGACY_FRESH) ? NOW_MS - 1_000 : undefined)
    )
    rmMock.mockRejectedValue(Object.assign(new Error('locked'), { code: 'EBUSY' }))

    await cleanupLegacyRemoteClipboardStaging(TEMP_ROOT, NOW_MS)

    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('never follows legacy symlinks outside the shared temp root', async () => {
    opendirMock.mockResolvedValue(openedDirectory([directoryEntry(LEGACY_EXPIRED)]))
    lstatMock.mockImplementation(async (targetPath: string) =>
      targetPath === STAGING_ROOT
        ? safeDirectoryStats()
        : {
            ...safeDirectoryStats(),
            isDirectory: () => false,
            isSymbolicLink: () => true
          }
    )

    await cleanupLegacyRemoteClipboardStaging(TEMP_ROOT, NOW_MS)

    expect(rmMock).not.toHaveBeenCalled()
    expect(writeFileMock).toHaveBeenCalledOnce()
  })

  it('skips the shared root after the one-time marker exists', async () => {
    accessMock.mockResolvedValue(undefined)

    await cleanupLegacyRemoteClipboardStaging(TEMP_ROOT, NOW_MS)

    expect(accessMock).toHaveBeenCalledWith(MARKER_PATH)
    expect(opendirMock).not.toHaveBeenCalled()
  })

  it('uses a platform-safe owned parent name', () => {
    expect(getRemoteClipboardStagingRoot(TEMP_ROOT)).toBe(STAGING_ROOT)
  })
})
