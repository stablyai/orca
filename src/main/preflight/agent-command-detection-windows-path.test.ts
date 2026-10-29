import type * as FileSystemPromises from 'node:fs/promises'
import path from 'node:path'
import type * as NodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openDirectory, statFile, detectInstallDirs } = vi.hoisted(() => ({
  openDirectory: vi.fn(),
  statFile: vi.fn(),
  detectInstallDirs: vi.fn(() => new Set<string>())
}))

// Model native Windows path semantics even when this suite runs on a POSIX host.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof NodePath>()
  return { ...actual, ...actual.win32, default: actual.win32 }
})
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystemPromises>()),
  opendir: openDirectory,
  stat: statFile
}))
vi.mock('../ipc/command-path-directory-worker-client', async () => ({
  readDetectionDirectoryViaWorker: (await import('../ipc/command-path-directory'))
    .readDetectionDirectory
}))
vi.mock('../../shared/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: detectInstallDirs
}))
vi.mock('../pty/windows-environment-path', () => ({
  mergePersistedWindowsPath: vi.fn()
}))
vi.mock('../ipc/wsl-guest-windows-drive-path', () => ({
  readGuestWindowsDriveMounts: () => []
}))

import { detectAgentCommandsOnHost } from './agent-command-detection'

describe('Windows host detection with PATH fallback skipped', () => {
  const originalPlatform = process.platform
  const shareDirectory = String.raw`\\review-server\tools\bin`
  const executable = String.raw`\\review-server\tools\bin\codex.cmd`

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    detectInstallDirs.mockClear()
    openDirectory.mockReset().mockImplementation(async (dir: string) => ({
      async *[Symbol.asyncIterator]() {
        if (path.normalize(dir).toLowerCase() === shareDirectory) {
          yield { name: 'codex.cmd' }
        }
      }
    }))
    statFile.mockReset().mockImplementation(async (candidate: string) => {
      if (path.normalize(candidate).toLowerCase() !== executable) {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      }
      return { isFile: () => true, isDirectory: () => false }
    })
    vi.stubEnv('PATHEXT', '.COM')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it.each(['//review-server/tools/bin', shareDirectory])(
    'detects a shim installed only in the UNC PATH entry %s',
    async (directory) => {
      vi.stubEnv('PATH', directory)

      await expect(detectAgentCommandsOnHost(['codex'])).resolves.toEqual(new Set(['codex']))
      expect(detectInstallDirs).toHaveBeenCalledWith([], undefined, { skipPathSearch: true })
    }
  )
})
