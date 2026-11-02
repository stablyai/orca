import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmShellForegroundProcess } from './agent-foreground-process'

// WSL panes expose wsl.exe, not a provable guest shell; recovery must remain blocked without a guest-side proof.
const realPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
})

describe('shell foreground proof for WSL panes', () => {
  it.each(['wsl.exe', 'C:\\Windows\\System32\\wsl.exe'])(
    'refutes %s even when the PTY job holds only the shell',
    async (spawnedShellProcess) => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const readWindowsPtyJobProcessIds = vi.fn(() => new Set([100]))

      await expect(
        confirmShellForegroundProcess(100, spawnedShellProcess, { readWindowsPtyJobProcessIds })
      ).resolves.toBe(false)
      expect(readWindowsPtyJobProcessIds).not.toHaveBeenCalled()
    }
  )
})
