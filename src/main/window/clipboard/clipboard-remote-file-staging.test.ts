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

vi.mock('node:timers/promises', () => ({
  // ast-grep-ignore: test-no-real-time-wait -- exposes retry backoff to vi.useFakeTimers for deterministic cleanup tests
  setTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
}))

vi.mock('node:fs/promises', () => ({
  access: accessMock,
  lstat: lstatMock,
  mkdir: mkdirMock,
  opendir: opendirMock,
  rm: rmMock,
  writeFile: writeFileMock
}))

import { removeRemoteClipboardTransferDirectory } from './clipboard-remote-file-staging'

const TTL_MS = 60 * 60 * 1000
const NOW_MS = 1_760_000_000_000
const TEMP_ROOT = resolve('fixture-temp')
const UID_SUFFIX = typeof process.getuid === 'function' ? `-${process.getuid()}` : ''
const STAGING_ROOT = join(TEMP_ROOT, `orca-clipboard-files${UID_SUFFIX}`)

type MockDirent = { name: string; isDirectory: () => boolean }

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

  it('contains explicit removals to direct owned children', async () => {
    expect(
      await removeRemoteClipboardTransferDirectory(TEMP_ROOT, join(STAGING_ROOT, '..', 'victim'))
    ).toBe(false)
    expect(await removeRemoteClipboardTransferDirectory(TEMP_ROOT, STAGING_ROOT)).toBe(false)

    expect(rmMock).not.toHaveBeenCalled()
  })
})
