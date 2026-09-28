import { describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn((..._args: unknown[]) => ({ pid: 1 }))
}))

vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawnMock }))

vi.mock('../wsl', () => ({ listRunningWslDistrosAsync: vi.fn() }))

import { listRunningWslDistrosAsync } from '../wsl'
import { isWslDistroRunning, spawnWslRelayProcess } from './wsl-hook-relay-launch'

describe('spawnWslRelayProcess', () => {
  it('pins the explicit user before --exec', () => {
    spawnWslRelayProcess('Ubuntu', {}, '1.2.3', '/home/ada/bun', 'ada')
    expect(spawnMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: [
          '-d',
          'Ubuntu',
          '--user',
          'ada',
          '--exec',
          'sh',
          '-c',
          expect.any(String),
          'orca-hook-relay',
          '/home/ada/bun'
        ]
      })
    )
  })

  it('names an explicit Windows directory rather than inheriting one', () => {
    spawnWslRelayProcess('Ubuntu', {}, '1.2.3', '/home/ada/bun')

    // Why (#16463): the guest path is inside the `sh -c` command, so the Windows
    // cwd only decides whether CreateProcessW succeeds. Omitting it inherits
    // Orca's own — a `\\wsl.localhost` worktree the user can delete, after which
    // every relay launch fails `spawn wsl.exe ENOENT` for the rest of the session.
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'wsl.exe',
        args: expect.arrayContaining(['-d', 'Ubuntu', '--exec', '/home/ada/bun']),
        cwd: expect.any(String)
      })
    )
  })
})

it('requires confirmed running state instead of cached fallback membership', async () => {
  vi.mocked(listRunningWslDistrosAsync).mockResolvedValueOnce(['Ubuntu'])
  await expect(isWslDistroRunning('ubuntu')).resolves.toBe(true)
  expect(listRunningWslDistrosAsync).toHaveBeenCalledWith({ requireConfirmed: true })
  vi.mocked(listRunningWslDistrosAsync).mockRejectedValueOnce(new Error('discovery unavailable'))
  await expect(isWslDistroRunning('Ubuntu')).rejects.toThrow('discovery unavailable')
})
