import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl/execution/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { detectWslCommandsOnPath } from './preflight-wsl-agent-detection'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'

describe('the detection script itself, run by a real POSIX shell', () => {
  // Execute real shell globbing and executable checks; Windows has no /bin/sh.
  const itPosix = process.platform === 'win32' ? it.skip : it
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-wsl-detect-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const plant = (dir: string, name: string): void => {
    mkdirSync(join(home, dir), { recursive: true })
    const file = join(home, dir, name)
    writeFileSync(file, '#!/bin/sh\necho hi\n')
    chmodSync(file, 0o755)
  }

  const runScript = async (commands = ['orca-fake-cli', 'nosuchtool']): Promise<string> => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: false,
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    await detectWslCommandsOnPath({ distro: 'Ubuntu' }, commands)
    const script = String(runWslProcessMock.mock.calls.at(-1)?.[0].script)
    const options: ExecFileSyncOptions = {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin' }
    }
    return String(execFileSync('/bin/sh', ['-c', script], options))
  }

  itPosix('finds an nvm-installed binary the login PATH would have shown', async () => {
    // Version-manager fallback must recover a CLI absent from login PATH (#9725).
    plant('.nvm/versions/node/v20.1.0/bin', 'orca-fake-cli')
    const out = await runScript()
    expect(out).toContain('__ORCA_AGENT_PATH__orca-fake-cli')
    expect(out).toContain('.nvm/versions/node/v20.1.0/bin/orca-fake-cli')
  })

  itPosix('finds a CLI when $HOME contains a space', async () => {
    // HOME with spaces must remain one path throughout fallback glob expansion.
    const spaced = mkdtempSync(join(tmpdir(), 'orca has space-'))
    const previous = home
    home = spaced
    try {
      plant('.nvm/versions/node/v20.1.0/bin', 'orca-fake-cli')
      expect(await runScript()).toContain(`${spaced}/.nvm/versions/node/v20.1.0/bin/orca-fake-cli`)
    } finally {
      home = previous
      rmSync(spaced, { recursive: true, force: true })
    }
  })

  itPosix('does not report a directory as an installed CLI', async () => {
    // Directories pass -x but would fail to launch with EISDIR.
    mkdirSync(join(home, '.local/bin/orca-fake-cli'), { recursive: true })
    expect(await runScript()).not.toContain('__ORCA_AGENT_PATH__orca-fake-cli')
  })

  itPosix('resolves a tilde executable without changing its inventory identity', async () => {
    plant('custom bin', 'orca-fake-cli')
    expect(await runScript(['~/custom bin/orca-fake-cli'])).toBe(
      `__ORCA_AGENT_PATH__~/custom bin/orca-fake-cli\t${home}/custom bin/orca-fake-cli\n`
    )
  })
})

describe('the PATH walk, run by a real POSIX shell', () => {
  const itPosix = process.platform === 'win32' ? it.skip : it

  itPosix('finds the guest install behind a Windows binary that shadows it', async () => {
    // Skip Windows components during the walk so an interop binary cannot hide a later guest install.
    const root = mkdtempSync(join(tmpdir(), 'orca-walk-'))
    try {
      const win = join(root, 'winmnt/c/npm')
      const nvm = join(root, 'home/.nvm/bin')
      for (const [dir, body] of [
        [win, 'win'],
        [nvm, 'guest']
      ] as const) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'claude'), `#!/bin/sh\necho ${body}\n`)
        chmodSync(join(dir, 'claude'), 0o755)
      }
      const script = buildPosixCommandPathLookupScript(
        { kind: 'literal', value: 'claude' },
        { skipWindowsMountDirs: true }
        // Substitute synthetic Windows-mount evidence for /proc/mounts.
      ).replace(/_orca_win_mounts=\$\([^)]*\)/, `_orca_win_mounts=${join(root, 'winmnt')}`)
      const options: ExecFileSyncOptions = {
        encoding: 'utf8',
        env: { PATH: `${win}:${nvm}:/usr/bin:/bin` }
      }
      const out = String(
        execFileSync('/bin/sh', ['-c', `${script}\nprintf %s "$resolved"`], options)
      )
      expect(out).toBe(join(nvm, 'claude'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the mount table read, counted against a real shell', () => {
  const itPosix = process.platform === 'win32' ? it.skip : it

  itPosix('applies the memoised mount list to every command, not just the first', async () => {
    // Fork counts alone miss a clobbered mount cache; all later agents must still skip Windows mounts.
    const root = mkdtempSync(join(tmpdir(), 'orca-memo-'))
    try {
      const win = join(root, 'winmnt/c/npm')
      const guest = join(root, 'home/bin')
      for (const [dir, body] of [
        [win, 'win'],
        [guest, 'guest']
      ] as const) {
        mkdirSync(dir, { recursive: true })
        for (const name of ['claude', 'codex']) {
          writeFileSync(join(dir, name), `#!/bin/sh\necho ${body}\n`)
          chmodSync(join(dir, name), 0o755)
        }
      }
      runWslProcessMock.mockResolvedValue({
        environmentResolved: true,
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false
      })
      await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])
      const script = String(runWslProcessMock.mock.calls.at(-1)?.[0].script).replace(
        /_orca_win_mounts=\$\([^)]*\)/,
        `_orca_win_mounts=${join(root, 'winmnt')}`
      )
      const options: ExecFileSyncOptions = {
        encoding: 'utf8',
        env: { PATH: `${win}:${guest}:/usr/bin:/bin`, HOME: root }
      }
      const out = String(execFileSync('/bin/sh', ['-c', script], options))
      expect(out).toContain(`__ORCA_AGENT_PATH__claude\t${join(guest, 'claude')}`)
      expect(out).toContain(`__ORCA_AGENT_PATH__codex\t${join(guest, 'codex')}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('strict WSL execution-host admission', () => {
  const success = {
    environmentResolved: true,
    code: 0,
    stdout: '__ORCA_AGENT_PATH__claude\t/usr/bin/claude\n',
    stderr: '',
    timedOut: false
  }

  beforeEach(() => {
    runWslProcessMock.mockReset()
  })

  it.each([{ environmentResolved: false }, { timedOut: true }, { code: 1 }])(
    'rejects failed inventory probes but keeps background inventory empty: %j',
    async (failure) => {
      runWslProcessMock.mockImplementation(async ({ script }) =>
        script === ':' ? success : { ...success, ...failure }
      )
      await expect(
        detectWslCommandsOnPath({}, ['claude'], { failOnProbeError: true })
      ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
      await expect(detectWslCommandsOnPath({}, ['claude'])).resolves.toEqual(new Set())
    }
  )

  it.each([{ environmentResolved: false }, { timedOut: true }, { code: 1 }])(
    'rejects an unavailable guest before inventory can report a launcher: %j',
    async (failure) => {
      runWslProcessMock.mockImplementation(async ({ script }) =>
        script === ':' ? { ...success, ...failure } : success
      )
      await expect(
        detectWslCommandsOnPath({}, ['claude'], { failOnProbeError: true })
      ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    }
  )

  it('classifies process exceptions without breaking background discovery', async () => {
    runWslProcessMock.mockRejectedValue(new Error('WSL unavailable'))
    await expect(
      detectWslCommandsOnPath({}, ['claude'], { failOnProbeError: true })
    ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    await expect(detectWslCommandsOnPath({}, ['claude'])).resolves.toEqual(new Set())
  })

  it('allows a cold guest to boot separately from its bounded login-PATH inventory', async () => {
    let ready = false
    runWslProcessMock.mockImplementation(async ({ script, shell, loginPath, timeoutMs }) => {
      if (script === ':') {
        ready = shell === 'sh' && loginPath === 'none' && timeoutMs === 60_000
        return ready ? success : { ...success, timedOut: true }
      }
      return ready && shell === 'sh' && loginPath === 'preferred' && timeoutMs === 10_000
        ? success
        : { ...success, timedOut: true }
    })
    await expect(
      detectWslCommandsOnPath({}, ['claude'], { failOnProbeError: true })
    ).resolves.toEqual(new Set(['claude']))
  })
})
