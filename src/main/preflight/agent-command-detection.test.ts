import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DrivePath from '../ipc/wsl-guest-windows-drive-path'

const { detectInstallDirs, guestMounts } = vi.hoisted(() => {
  const value: readonly string[] = []
  return {
    detectInstallDirs: vi.fn(
      (_commands: readonly string[], _pathEnv?: string) => new Map<string, string>()
    ),
    guestMounts: { value }
  }
})

// Why the resolve shape: detection keeps each hit's path for the identity probe, so the
// fallback it calls is resolveCommandsInInstallDirs.
vi.mock('../ipc/local-agent-install-dir-detection', () => ({
  resolveCommandsInInstallDirs: detectInstallDirs
}))
vi.mock('../ipc/preflight-command-exec', () => ({
  resolveLocalCommandPath: vi.fn(async () => null)
}))
vi.mock('../ipc/wsl-guest-windows-drive-path', async (importOriginal) => ({
  ...(await importOriginal<typeof DrivePath>()),
  readGuestWindowsDriveMounts: () => guestMounts.value
}))

import { detectAgentCommandsOnHost } from './agent-command-detection'

describe('detectAgentCommandsOnHost install-dir fallback', () => {
  beforeEach(() => {
    detectInstallDirs.mockClear()
    guestMounts.value = []
  })

  // Regression: Windows must keep searching the process PATH, not the persisted-registry merge.
  it('searches the process PATH everywhere except a WSL host orcad', async () => {
    await detectAgentCommandsOnHost(['codex'])
    expect(detectInstallDirs).toHaveBeenCalledWith(['codex'], undefined)
  })

  it.skipIf(process.platform === 'win32')(
    'drops /mnt/<drive> dirs from the fallback PATH on a WSL host orcad',
    async () => {
      guestMounts.value = ['/mnt/c']
      const original = process.env.PATH
      process.env.PATH = '/usr/bin:/mnt/c/Users/u/AppData/Roaming/npm'
      try {
        await detectAgentCommandsOnHost(['codex'])
      } finally {
        process.env.PATH = original
      }
      expect(detectInstallDirs).toHaveBeenCalledWith(['codex'], '/usr/bin')
    }
  )
})
