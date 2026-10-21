import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DarwinUserTempDir from './darwin-user-temp-dir'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

async function loadResolver(): Promise<typeof DarwinUserTempDir> {
  vi.resetModules()
  return import('./darwin-user-temp-dir')
}

function getconfResult(stdout: string, code = 0) {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

beforeEach(() => {
  runProcessMock.mockReset()
})

describe('getDarwinUserTempDir', () => {
  it('asks getconf once and ignores a custom $TMPDIR', async () => {
    runProcessMock.mockResolvedValue(getconfResult('/var/folders/ab/xyz/T/\n'))
    const { getDarwinUserTempDir } = await loadResolver()

    expect(await getDarwinUserTempDir('darwin')).toBe('/var/folders/ab/xyz/T/')
    expect(await getDarwinUserTempDir('darwin')).toBe('/var/folders/ab/xyz/T/')
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock.mock.calls[0][0]).toMatchObject({
      program: '/usr/bin/getconf',
      args: ['DARWIN_USER_TEMP_DIR']
    })
  })

  it('falls back to os.tmpdir() on failure and asks again next time', async () => {
    runProcessMock
      .mockResolvedValueOnce(getconfResult('', 1))
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce(getconfResult('/var/folders/ab/xyz/T/\n'))
    const { getDarwinUserTempDir } = await loadResolver()

    expect(await getDarwinUserTempDir('darwin')).toBe(tmpdir())
    expect(await getDarwinUserTempDir('darwin')).toBe(tmpdir())
    expect(await getDarwinUserTempDir('darwin')).toBe('/var/folders/ab/xyz/T/')
  })

  it('uses os.tmpdir() without spawning off macOS', async () => {
    const { getDarwinUserTempDir } = await loadResolver()

    expect(await getDarwinUserTempDir('linux')).toBe(tmpdir())
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
