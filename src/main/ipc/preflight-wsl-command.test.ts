import { beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { runPreflightCommandInWsl } from './preflight-wsl-command'

beforeEach(() => {
  runWslProcessMock.mockReset()
  runWslProcessMock.mockResolvedValue({
    environmentResolved: false,
    code: 0,
    stdout: 'gh version 2.0.0',
    stderr: '',
    timedOut: false
  })
})

describe('runPreflightCommandInWsl', () => {
  it('prefers the login PATH but never lets its absence decide the answer', async () => {
    // Every caller collapses a throw into a verdict: isCommandAvailable returns
    // false ("not installed"), isGhAuthenticated reads an empty payload as
    // "not authenticated". A missing login PATH must therefore never be fatal.
    await runPreflightCommandInWsl({ distro: 'Ubuntu' }, 'gh --version', 5_000)

    expect(runWslProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ loginPath: 'preferred', distro: 'Ubuntu' })
    )
  })

  it('still rejects with stdout and stderr attached on a non-zero exit', async () => {
    // isGhAuthenticated reads these off the caught error as an auth-success
    // fallback, so dropping them would break gh-in-WSL detection.
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 1,
      stdout: 'partial',
      stderr: 'boom',
      timedOut: false
    })

    await expect(
      runPreflightCommandInWsl({ distro: 'Ubuntu' }, 'gh auth status', 5_000)
    ).rejects.toMatchObject({ stdout: 'partial', stderr: 'boom', code: 1 })
  })
})
