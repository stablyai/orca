import { beforeEach, describe, expect, it, vi } from 'vitest'

const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import {
  findStalePermissionStatusHelperPids,
  sweepStalePermissionStatusHelpers
} from './macos-computer-use-permission-helper-sweep'

const HELPER = '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
const dir = (id: string): string => `/var/folders/xx/T/orca-computer-use-permissions-${id}`
const line = (pid: number, id: string): string =>
  `${pid} ${HELPER} --permission-status-file ${dir(id)}/status.json`

describe('findStalePermissionStatusHelperPids', () => {
  it('selects only helpers whose status directory is gone', () => {
    const live = new Set([dir('live')])
    const ps = [line(101, 'gone'), line(102, 'live'), line(103, 'gone2')].join('\n')
    expect(findStalePermissionStatusHelperPids(ps, (d) => live.has(d))).toEqual([101, 103])
  })

  it('leaves an in-flight check of another Orca instance alone', () => {
    const ps = line(200, 'other-profile')
    expect(findStalePermissionStatusHelperPids(ps, () => true)).toEqual([])
  })

  it('ignores setup helpers, unrelated processes and foreign status paths', () => {
    const ps = [
      `300 ${HELPER} --permission`,
      `301 ${HELPER} --permissions`,
      `302 /usr/bin/other --permission-status-file ${dir('a')}/status.json`,
      `303 ${HELPER} --permission-status-file /tmp/user-file/status.json`,
      `304 ${HELPER} --permission-status-file ${dir('a')}/other.json`,
      'garbage line'
    ].join('\n')
    expect(findStalePermissionStatusHelperPids(ps, () => false)).toEqual([])
  })
})

describe('sweepStalePermissionStatusHelpers', () => {
  const originalPlatform = process.platform
  beforeEach(() => {
    runProcessMock.mockReset()
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('does nothing off macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    await sweepStalePermissionStatusHelpers()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('lists only the current user and SIGKILLs stale helpers', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    runProcessMock.mockResolvedValue({ code: 0, stdout: line(555, 'gone'), timedOut: false })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const killed = await sweepStalePermissionStatusHelpers()
    expect(runProcessMock.mock.calls[0][0].args).toEqual(
      expect.arrayContaining(['-U', String(process.getuid?.())])
    )
    expect(kill).toHaveBeenCalledWith(555, 'SIGKILL')
    expect(killed).toEqual([555])
    kill.mockRestore()
  })

  it('swallows ps failures', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    runProcessMock.mockRejectedValue(new Error('spawn ps ENOENT'))
    await expect(sweepStalePermissionStatusHelpers()).resolves.toEqual([])
  })
})
