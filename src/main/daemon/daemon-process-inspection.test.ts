import { describe, expect, it, vi } from 'vitest'
import { queryWindowsProcess, readProcessCommandLine } from './daemon-process-inspection'

describe('daemon process inspection', () => {
  it('falls back to ps when Linux procfs returns an empty command line', async () => {
    const readTextFile = vi.fn(async () => '')
    const runCommand = vi.fn(async () => 'node daemon-entry --socket daemon.sock')

    await expect(readProcessCommandLine(42, 'linux', { readTextFile, runCommand })).resolves.toBe(
      'node daemon-entry --socket daemon.sock'
    )
    expect(readTextFile).toHaveBeenCalledWith('/proc/42/cmdline')
    expect(runCommand).toHaveBeenCalledWith('ps', ['-p', '42', '-o', 'command='], 2_000)
  })

  it('uses a non-empty Linux procfs command line without spawning ps', async () => {
    const readTextFile = vi.fn(async () => 'node\0daemon-entry')
    const runCommand = vi.fn()

    await expect(readProcessCommandLine(42, 'linux', { readTextFile, runCommand })).resolves.toBe(
      'node\0daemon-entry'
    )
    expect(runCommand).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects unsafe Windows pid %s before command interpolation',
    async (pid) => {
      const runCommand = vi.fn()

      await expect(queryWindowsProcess(pid, { runCommand })).resolves.toEqual({
        status: 'unavailable'
      })
      expect(runCommand).not.toHaveBeenCalled()
    }
  )
})
