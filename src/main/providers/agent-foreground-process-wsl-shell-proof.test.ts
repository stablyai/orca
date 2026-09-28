import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmShellForegroundProcess } from './agent-foreground-process'

// Why pinned: daemon WSL panes spawn `wsl.exe` (pty-subprocess/shell-launch-plan.ts),
// which reaches this proof through pty-shell-foreground-confirmation.ts and is not a
// shell name, so the recovery barrier never grounds WSL panes and the renderer's
// reset tree keeps covering them. A future WSL proof must change this deliberately.
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
