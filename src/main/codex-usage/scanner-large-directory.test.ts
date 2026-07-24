import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dir, Dirent, Stats } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'

const { getLegacyCopiedCodexSessionBridgeScanPreferenceMock, opendirMock, statMock } = vi.hoisted(
  () => ({
    getLegacyCopiedCodexSessionBridgeScanPreferenceMock: vi.fn(),
    opendirMock: vi.fn<(dirPath: string) => Promise<Dir>>(),
    statMock: vi.fn<(filePath: string) => Promise<Stats>>()
  })
)

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return {
    ...actual,
    opendir: opendirMock,
    stat: statMock
  }
})

const FILE_COUNT = 125_000
const FAKE_ROOT = join('/', 'tmp', 'orca-large-codex-home')
const RUNTIME_SESSIONS_ROOT = join(FAKE_ROOT, 'runtime', 'sessions')
const SYSTEM_SESSIONS_ROOT = join(FAKE_ROOT, 'system', 'sessions')
const RUNTIME_BULK_DIR = join(RUNTIME_SESSIONS_ROOT, 'bulk')

vi.mock('../codex/codex-home-paths', () => ({
  getOrcaManagedCodexHomePath: () => join(FAKE_ROOT, 'runtime'),
  getOrcaUserDataPath: () => FAKE_ROOT,
  getSystemCodexHomePath: () => join(FAKE_ROOT, 'system')
}))

vi.mock('../codex/codex-session-bridge', () => ({
  getLegacyCopiedCodexSessionBridgeScanPreference:
    getLegacyCopiedCodexSessionBridgeScanPreferenceMock
}))

function dirent(name: string, kind: 'directory' | 'file'): Dirent {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file'
  } as Dirent
}

const largeSessionEntries = Array.from({ length: FILE_COUNT }, (_, index) =>
  dirent(`session-${index}.jsonl`, 'file')
)

function directory(entries: Dirent[]): Dir {
  return {
    async *[Symbol.asyncIterator]() {
      yield* entries
    }
  } as Dir
}

function generatedFileDirectory(count: number): Dir {
  return {
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < count; index++) {
        yield dirent(`session-${index}.jsonl`, 'file')
      }
    }
  } as Dir
}

describe('listCodexSessionFiles large directories', () => {
  beforeEach(() => {
    getLegacyCopiedCodexSessionBridgeScanPreferenceMock.mockReset()
    getLegacyCopiedCodexSessionBridgeScanPreferenceMock.mockReturnValue(null)
    opendirMock.mockReset()
    statMock.mockReset()
  })

  it('keeps nested session scans past the JavaScript spread-argument limit', async () => {
    opendirMock.mockImplementation(async (dirPath) => {
      if (dirPath === RUNTIME_SESSIONS_ROOT) {
        return directory([dirent('bulk', 'directory')])
      }
      if (dirPath === RUNTIME_BULK_DIR) {
        return directory(largeSessionEntries)
      }
      if (dirPath === SYSTEM_SESSIONS_ROOT) {
        return directory([])
      }
      throw new Error(`Unexpected opendir path: ${dirPath}`)
    })
    statMock.mockImplementation(async (filePath) => {
      const match = /session-(\d+)\.jsonl$/.exec(filePath.replaceAll('\\', '/'))
      return {
        dev: 1,
        ino: match ? Number(match[1]) + 1 : 0
      } as Stats
    })

    const { listCodexSessionFiles } = await import('./scanner')

    await expect(listCodexSessionFiles()).resolves.toHaveLength(FILE_COUNT)
    expect(getLegacyCopiedCodexSessionBridgeScanPreferenceMock).not.toHaveBeenCalled()
  })

  it('fails closed instead of silently omitting a rollout past capacity', async () => {
    opendirMock.mockImplementation(async (dirPath) => {
      if (dirPath === RUNTIME_SESSIONS_ROOT) {
        return generatedFileDirectory(200_001)
      }
      if (dirPath === SYSTEM_SESSIONS_ROOT) {
        return directory([])
      }
      throw new Error(`Unexpected opendir path: ${dirPath}`)
    })

    const { listCodexSessionFiles } = await import('./scanner')

    await expect(listCodexSessionFiles()).rejects.toMatchObject({
      name: 'UsageHistoryScanCapacityError',
      resource: 'files',
      limit: 200_000
    })
  })
})
