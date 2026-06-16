import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dirent, Stats } from 'node:fs'
import type * as FsPromises from 'fs/promises'
import { join } from 'path'

const { getLegacyCopiedCodexSessionBridgeScanPreferenceMock, readdirMock, statMock } = vi.hoisted(
  () => ({
    getLegacyCopiedCodexSessionBridgeScanPreferenceMock: vi.fn(),
    readdirMock: vi.fn<(dirPath: string) => Promise<Dirent[]>>(),
    statMock: vi.fn<(filePath: string) => Promise<Stats>>()
  })
)

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return {
    ...actual,
    readdir: readdirMock,
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

describe('listCodexSessionFiles large directories', () => {
  beforeEach(() => {
    getLegacyCopiedCodexSessionBridgeScanPreferenceMock.mockReset()
    getLegacyCopiedCodexSessionBridgeScanPreferenceMock.mockReturnValue(null)
    readdirMock.mockReset()
    statMock.mockReset()
  })

  it('keeps nested session scans past the JavaScript spread-argument limit', async () => {
    readdirMock.mockImplementation(async (dirPath) => {
      if (dirPath === RUNTIME_SESSIONS_ROOT) {
        return [dirent('bulk', 'directory')]
      }
      if (dirPath === RUNTIME_BULK_DIR) {
        return largeSessionEntries
      }
      if (dirPath === SYSTEM_SESSIONS_ROOT) {
        return []
      }
      throw new Error(`Unexpected readdir path: ${dirPath}`)
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
})
