import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { detectWslCommandsOnPath } from './preflight-wsl-agent-detection'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'

describe('detectWslCommandsOnPath', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ignores commands whose resolved path is not absolute', async () => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout: '__ORCA_AGENT_PATH__claude\tclaude\n' + '__ORCA_AGENT_PATH__codex\tC:\\spoof\n',
      stderr: '',
      timedOut: false
    })

    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])

    expect(found).toEqual(new Set())
  })
})

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

  const runScript = async (): Promise<string> => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: false,
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['orca-fake-cli', 'nosuchtool'])
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

  itPosix('still reports nothing for a command that is genuinely absent', async () => {
    plant('.local/bin', 'orca-fake-cli')
    expect(await runScript()).not.toContain('nosuchtool')
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

  const runWithCountingAwk = async (commands: string[]): Promise<number> => {
    const root = mkdtempSync(join(tmpdir(), 'orca-awk-'))
    try {
      const counter = join(root, 'count')
      const bin = join(root, 'bin')
      mkdirSync(bin, { recursive: true })
      // A stub that records each fork, then answers as awk would on a host
      // with no Windows mounts.
      writeFileSync(join(bin, 'awk'), `#!/bin/sh\necho x >> ${counter}\nexit 0\n`)
      chmodSync(join(bin, 'awk'), 0o755)
      writeFileSync(counter, '')

      runWslProcessMock.mockResolvedValue({
        environmentResolved: true,
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false
      })
      await detectWslCommandsOnPath({ distro: 'Ubuntu' }, commands)
      const script = String(runWslProcessMock.mock.calls.at(-1)?.[0].script)
      const options: ExecFileSyncOptions = {
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root }
      }
      execFileSync('/bin/sh', ['-c', script], options)
      return readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  itPosix('reads /proc/mounts once, not once per probed command', async () => {
    // Cache mount discovery across the per-agent loop to avoid repeated awk forks.
    expect(await runWithCountingAwk(['claude', 'codex', 'gemini', 'opencode'])).toBe(1)
  })

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
