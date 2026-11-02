import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DrivePath from '../ipc/wsl-guest-windows-drive-path'
import type * as CommandPathResolver from '../ipc/command-path-resolver'

const { detectInstallDirs, guestMounts } = vi.hoisted(() => {
  const value: readonly string[] = []
  return {
    detectInstallDirs: vi.fn(
      (_commands: readonly string[], _pathEnv?: string) => new Set<string>()
    ),
    guestMounts: { value }
  }
})

vi.mock('../../shared/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: detectInstallDirs
}))
vi.mock('../pty/windows-environment-path', () => ({
  mergePersistedWindowsPath: vi.fn()
}))
vi.mock('../ipc/command-path-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof CommandPathResolver>()
  return { ...actual, findCommandsOnLocalPath: vi.fn(actual.findCommandsOnLocalPath) }
})
vi.mock('../ipc/wsl-guest-windows-drive-path', async (importOriginal) => ({
  ...(await importOriginal<typeof DrivePath>()),
  readGuestWindowsDriveMounts: () => guestMounts.value
}))

import { detectAgentCommandsOnHost } from './agent-command-detection'
import { findCommandsOnLocalPath, isCommandOnLocalPath } from '../ipc/command-path-resolver'

describe('detectAgentCommandsOnHost install-dir fallback', () => {
  const originalPlatform = process.platform
  afterEach(() => {
    vi.unstubAllEnvs()
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  beforeEach(() => {
    detectInstallDirs.mockClear()
    guestMounts.value = []
  })

  it.skipIf(process.platform === 'win32')(
    'drops /mnt/<drive> dirs from the fallback PATH on a WSL host orcad',
    async () => {
      guestMounts.value = ['/mnt/c']
      const original = process.env.PATH
      process.env.PATH = '/usr/bin:/mnt/c/Users/u/AppData/Roaming/npm'
      try {
        vi.mocked(findCommandsOnLocalPath).mockResolvedValueOnce(new Set())
        await detectAgentCommandsOnHost(['codex'])
      } finally {
        process.env.PATH = original
      }
      expect(detectInstallDirs).toHaveBeenCalledWith(['codex'], '/usr/bin', {
        skipPathSearch: true
      })
    }
  )

  it.skipIf(process.platform === 'win32').each([
    ['AgEnT-PrObE', 'agent-probe'],
    ['cruſh', 'crush']
  ])(
    'preserves filesystem equivalence for %s when looking up %s with PATH fallback skipped',
    async (filename, command) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'agent-detection-case-'))
      try {
        await writeFile(path.join(dir, filename), '#!/bin/sh\n')
        await chmod(path.join(dir, filename), 0o755)
        vi.stubEnv('PATH', dir)
        const commands = [command, 'missing-a', 'missing-b', 'missing-c', 'missing-d']
        const expected = await isCommandOnLocalPath(command)
        await expect(detectAgentCommandsOnHost(commands)).resolves.toEqual(
          new Set(expected ? [command] : [])
        )
        expect(detectInstallDirs).toHaveBeenCalledWith(
          expected ? commands.slice(1) : commands,
          undefined,
          { skipPathSearch: true }
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it.each(['.cmd', '.exe', '.bat'])(
    'detects a Windows fallback %s shim outside install directories with restricted PATHEXT',
    async (extension) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'agent-detection-ext-'))
      try {
        await writeFile(path.join(dir, `agent-probe${extension}`), '')
        vi.stubEnv('PATH', dir)
        vi.stubEnv('PATHEXT', '.COM')
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
        await expect(detectAgentCommandsOnHost(['agent-probe'])).resolves.toEqual(
          new Set(['agent-probe'])
        )
        expect(detectInstallDirs).toHaveBeenCalledWith([], undefined, { skipPathSearch: true })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'retains fallback trimming of padded PATH entries',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'agent-detection-path-'))
      try {
        await writeFile(path.join(dir, 'agent-probe'), '#!/bin/sh\n')
        await chmod(path.join(dir, 'agent-probe'), 0o755)
        vi.stubEnv('PATH', ` ${dir} `)
        await expect(detectAgentCommandsOnHost(['agent-probe'])).resolves.toEqual(
          new Set(['agent-probe'])
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
})
