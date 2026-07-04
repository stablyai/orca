import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}))

vi.mock('node:util', () => ({
  promisify: () => execFileAsyncMock
}))

describe('collectShellAvailabilitySummary', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
  })

  it('bounds Windows shell probes and converts probe failures to false', async () => {
    execFileAsyncMock.mockRejectedValue(new Error('not found'))
    const { collectShellAvailabilitySummary } = await import('./shell-availability-summary')

    const summary = await collectShellAvailabilitySummary('win32')

    expect(summary).toEqual({
      platform: 'win32',
      shells: {
        'cmd.exe': false,
        'powershell.exe': false,
        'pwsh.exe': false,
        'wsl.exe': false,
        'bash.exe': false
      }
    })
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'where.exe',
      ['cmd.exe'],
      expect.objectContaining({ timeout: 2000, maxBuffer: 64 * 1024 })
    )
  })

  it('uses a bounded POSIX command lookup for Linux shells', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    const { collectShellAvailabilitySummary } = await import('./shell-availability-summary')

    const summary = await collectShellAvailabilitySummary('linux')

    expect(summary).toMatchObject({
      platform: 'linux',
      shells: {
        sh: true,
        bash: true,
        zsh: true,
        fish: true,
        pwsh: true
      }
    })
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'sh',
      ['-lc', "command -v 'sh' >/dev/null 2>&1"],
      expect.objectContaining({ timeout: 2000, maxBuffer: 64 * 1024 })
    )
  })
})
