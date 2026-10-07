import { beforeEach, describe, expect, it, vi } from 'vitest'

const runProcessMock = vi.hoisted(() => vi.fn())

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import {
  runMacPrivilegedCommand,
  runWindowsPathCommand,
  writeWindowsUserPath
} from './cli-privileged-processes'

describe('Windows CLI PATH process boundary', () => {
  beforeEach(() => runProcessMock.mockReset())

  it('uses the canonical process wrapper with the bounded timeout', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'ok',
      stderr: '',
      timedOut: false
    })

    await expect(runWindowsPathCommand(['-NoProfile'])).resolves.toBe('ok')
    expect(runProcessMock).toHaveBeenCalledWith({
      program: 'powershell',
      args: ['-NoProfile'],
      timeoutMs: 5_000
    })
  })

  it('preserves the timeout error presented by CLI registration', async () => {
    runProcessMock.mockResolvedValue({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: true
    })

    await expect(runWindowsPathCommand([])).rejects.toThrow(
      'Windows PATH command timed out after 5000ms.'
    )
  })

  it('retains stderr for permission classification', async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'UnauthorizedAccessException',
      timedOut: false
    })

    await expect(runWindowsPathCommand([])).rejects.toMatchObject({
      code: 1,
      message: 'UnauthorizedAccessException',
      stderr: 'UnauthorizedAccessException'
    })
  })

  it('doubles typographic single quotes in the PATH literal', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })

    await writeWindowsUserPath('C:\\O\u2019Brien\\bin')
    expect(runProcessMock.mock.calls[0][0].args.at(-1)).toBe(
      "[Environment]::SetEnvironmentVariable('Path', 'C:\\O\u2019\u2019Brien\\bin', 'User')"
    )
  })
})

describe('macOS CLI privileged process boundary', () => {
  beforeEach(() => runProcessMock.mockReset())

  it('uses the canonical process wrapper without a shell', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })

    await runMacPrivilegedCommand("ln -s 'source' 'target'")

    expect(runProcessMock).toHaveBeenCalledWith({
      program: 'osascript',
      args: ['-e', "do shell script \"ln -s 'source' 'target'\" with administrator privileges"],
      timeoutMs: null
    })
  })
})
