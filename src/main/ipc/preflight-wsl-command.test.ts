import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('the PATH fallback, run by a real POSIX shell', () => {
  const itPosix = process.platform === 'win32' ? it.skip : it

  itPosix('finds an nvm-installed CLI a degraded probe would have missed', async () => {
    // #9725: the caller turns a throw into "not installed", so a degraded probe
    // told the user to install a CLI their own terminal already runs.
    //
    // A fabricated name, not `gh`: CI has a real /usr/bin/gh, and the fallback
    // APPENDS, so the PATH lookup correctly found the real one and the planted
    // stub was never reached. The test was asserting the host, not the code.
    const home = mkdtempSync(join(tmpdir(), 'orca-wsl-cmd-'))
    try {
      const bin = join(home, '.nvm/versions/node/v20.1.0/bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'orca-fake-cli'), '#!/bin/sh\necho cli-ok\n')
      chmodSync(join(bin, 'orca-fake-cli'), 0o755)

      runWslProcessMock.mockResolvedValue({
        environmentResolved: false,
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false
      })
      await runPreflightCommandInWsl({ distro: 'Ubuntu' }, 'command -v orca-fake-cli', 5000)
      const script = String(runWslProcessMock.mock.calls.at(-1)?.[0].script)
      const options: ExecFileSyncOptions = {
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin' }
      }
      expect(String(execFileSync('/bin/sh', ['-c', script], options))).toContain(
        '.nvm/versions/node/v20.1.0/bin/orca-fake-cli'
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  itPosix('appends rather than prepends, so a resolved PATH still wins', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-wsl-cmd-'))
    const real = mkdtempSync(join(tmpdir(), 'orca-wsl-real-'))
    try {
      for (const [dir, body] of [
        [join(home, '.local/bin'), 'stale'],
        [real, 'current']
      ] as const) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'orca-fake-cli'), `#!/bin/sh\necho ${body}\n`)
        chmodSync(join(dir, 'orca-fake-cli'), 0o755)
      }
      runWslProcessMock.mockResolvedValue({
        environmentResolved: true,
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false
      })
      await runPreflightCommandInWsl({ distro: 'Ubuntu' }, 'orca-fake-cli', 5000)
      const script = String(runWslProcessMock.mock.calls.at(-1)?.[0].script)
      const options: ExecFileSyncOptions = {
        encoding: 'utf8',
        env: { HOME: home, PATH: `${real}:/usr/bin:/bin` }
      }
      expect(String(execFileSync('/bin/sh', ['-c', script], options)).trim()).toBe('current')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(real, { recursive: true, force: true })
    }
  })
})
