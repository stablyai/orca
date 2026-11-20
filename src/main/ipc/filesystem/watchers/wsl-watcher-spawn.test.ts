import { ChildProcess } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'

const { spawnProcessMock } = vi.hoisted(() => ({ spawnProcessMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({ spawnProcess: spawnProcessMock }))

import { spawnWslWatcherProcess } from './wsl-watcher-spawn'

afterEach(() => {
  vi.unstubAllEnvs()
  spawnProcessMock.mockReset()
})

it('spawns System32 wsl.exe for the WSL filesystem watcher', () => {
  vi.stubEnv('SystemRoot', 'D:\\Windows')
  spawnProcessMock.mockReturnValueOnce(new ChildProcess())

  spawnWslWatcherProcess('Ubuntu', '/home/dev/repo')

  expect(spawnProcessMock).toHaveBeenCalledWith(
    expect.objectContaining({
      program: 'D:\\Windows\\System32\\wsl.exe',
      args: ['-d', 'Ubuntu', '--exec', 'sh', '-s', '--', '/home/dev/repo']
    })
  )
})
