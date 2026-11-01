// A low-spec Windows machine timed out the first user-PATH write at 5 s; a retry then succeeded.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { writeWindowsUserPath } from './cli-privileged-processes'
import { WINDOWS_PATH_WRITE_TIMEOUT_MS } from './cli-install-constants'

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

const TIMED_OUT = result({ code: null, timedOut: true })

beforeEach(() => {
  runProcessMock.mockReset()
})

describe('writeWindowsUserPath', () => {
  it('allows a slow PowerShell well past the old 5 s deadline', async () => {
    runProcessMock.mockResolvedValue(result())

    await writeWindowsUserPath('C:\\Users\\me\\bin')

    expect(WINDOWS_PATH_WRITE_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000)
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'powershell', timeoutMs: WINDOWS_PATH_WRITE_TIMEOUT_MS })
    )
  })

  it('retries once after a timeout and succeeds', async () => {
    runProcessMock.mockResolvedValueOnce(TIMED_OUT).mockResolvedValueOnce(result())

    await expect(writeWindowsUserPath('C:\\Users\\me\\bin')).resolves.toBeUndefined()

    expect(runProcessMock).toHaveBeenCalledTimes(2)
    expect(runProcessMock.mock.calls[1]).toEqual(runProcessMock.mock.calls[0])
  })

  it('gives up after a second timeout', async () => {
    runProcessMock.mockResolvedValue(TIMED_OUT)

    await expect(writeWindowsUserPath('C:\\Users\\me\\bin')).rejects.toThrow(
      `Windows PATH command timed out after ${WINDOWS_PATH_WRITE_TIMEOUT_MS}ms.`
    )
    expect(runProcessMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a PowerShell failure', async () => {
    runProcessMock.mockResolvedValue(
      result({ code: 1, stderr: 'Access to the registry is denied.' })
    )

    await expect(writeWindowsUserPath('C:\\Users\\me\\bin')).rejects.toThrow(
      'Access to the registry is denied.'
    )
    expect(runProcessMock).toHaveBeenCalledOnce()
  })
})
