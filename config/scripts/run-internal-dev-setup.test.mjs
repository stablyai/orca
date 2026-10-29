import { describe, expect, it, vi } from 'vitest'
import { runInternalDevSetup } from './run-internal-dev-setup.mjs'

describe('runInternalDevSetup', () => {
  it('does nothing when ORCA_INTERNAL_DEV_SETUP is unset', () => {
    const spawn = vi.fn()

    expect(runInternalDevSetup({ env: {}, exists: vi.fn(), spawn })).toBe(0)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does nothing when the configured setup path does not exist', () => {
    const spawn = vi.fn()

    expect(
      runInternalDevSetup({
        env: { ORCA_INTERNAL_DEV_SETUP: '/tmp/missing' },
        exists: () => false,
        spawn
      })
    ).toBe(0)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('skips non-executable setup paths on POSIX', () => {
    const spawn = vi.fn()

    expect(
      runInternalDevSetup({
        env: { ORCA_INTERNAL_DEV_SETUP: '/tmp/setup' },
        platform: 'linux',
        exists: () => true,
        access: () => {
          throw new Error('EACCES')
        },
        spawn
      })
    ).toBe(0)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('runs the optional setup with the worktree path and ignores its exit status', () => {
    const spawn = vi.fn(() => ({ status: 1 }))

    expect(
      runInternalDevSetup({
        env: {
          ORCA_INTERNAL_DEV_SETUP: ' /tmp/setup ',
          ORCA_WORKTREE_PATH: '/tmp/worktree'
        },
        platform: 'linux',
        exists: () => true,
        access: () => undefined,
        spawn
      })
    ).toBe(0)
    expect(spawn).toHaveBeenCalledWith('/tmp/setup', ['/tmp/worktree'], {
      stdio: 'inherit'
    })
  })

  it.each([
    ['C:\\repo with spaces\\worktree', 'C:\\repo with spaces\\worktree'],
    ['/c/repo with spaces/worktree', 'C:\\repo with spaces\\worktree']
  ])('quotes Windows setup paths and converts MSYS worktree %s', (worktree, expected) => {
    const spawn = vi.fn(() => ({ status: 0 }))

    expect(
      runInternalDevSetup({
        env: {
          ORCA_INTERNAL_DEV_SETUP: 'C:\\tool suite\\setup.cmd',
          ORCA_WORKTREE_PATH: worktree
        },
        platform: 'win32',
        exists: () => true,
        spawn
      })
    ).toBe(0)
    expect(spawn).toHaveBeenCalledWith(
      'cmd.exe',
      ['/d', '/s', '/c', `call "C:\\tool suite\\setup.cmd" "${expected}"`],
      {
        stdio: 'inherit',
        windowsVerbatimArguments: true
      }
    )
  })
})
