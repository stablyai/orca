import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { detectWslCommandsOnPath } from './preflight-wsl-agent-detection'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'

type RunWslProcessSpec = { distro?: string; loginPath: string; script: string }

function lastSpec(): RunWslProcessSpec {
  const call = runWslProcessMock.mock.calls.at(-1)
  expect(call).toBeDefined()
  return (call as [RunWslProcessSpec])[0]
}

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

  it('asks for the login PATH without running a shell, so no banner can appear', async () => {
    await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])

    const spec = lastSpec()
    expect(spec.loginPath).toBe('preferred')
    expect(spec.distro).toBe('Ubuntu')
  })

  it('builds a probe script with no `fi done` (zsh parse error) sequence', async () => {
    await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])

    const { script } = lastSpec()
    // Why: zsh aborts on `fi done` — the loop body and `done` must be separated
    // by a newline. Regression guard for issue #5325.
    expect(script).not.toContain('fi done')
    expect(script).toContain('fi\ndone')
  })

  it('uses the shared alias- and function-neutral PATH lookup', async () => {
    await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])

    const { script } = lastSpec()
    const lookupScript = buildPosixCommandPathLookupScript(
      { kind: 'shell-variable', name: 'cmd' },
      // The WSL probe opts into skipping Windows mounts mid-walk.
      { skipWindowsMountDirs: true }
    )
    expect(script).toContain(lookupScript)
    expect(script).not.toContain('type -P')
  })

  it('parses detected commands from prefixed stdout', async () => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout:
        '__ORCA_AGENT_PATH__claude\t/usr/bin/claude\n' +
        '__ORCA_AGENT_PATH__codex\t/home/user/.local/bin/codex\n',
      stderr: '',
      timedOut: false
    })

    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex'])

    expect(found).toEqual(new Set(['claude', 'codex']))
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

  it('finds a real command even with rc/motd-shaped noise ahead of it in stdout (regression)', async () => {
    // Before this migration the site ran an uncaptured login shell
    // (buildWslLoginShellCommand) and parsed raw stdout, so the distro's
    // "run a command as administrator" rc/motd banner shared the stream with
    // the payload (#11327, #11823 class). The probe lane runs no shell at all,
    // so a banner has no way to appear; this proves the payload line still
    // parses correctly even when banner-shaped text precedes it.
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout:
        'Welcome to Ubuntu! Run a command as administrator (user "root")...\n' +
        '__ORCA_AGENT_PATH__claude\t/home/user/.nvm/versions/node/v20/bin/claude\n',
      stderr: '',
      timedOut: false
    })

    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])

    expect(found).toEqual(new Set(['claude']))
  })

  it('returns an empty set when wsl.exe cannot be started', async () => {
    runWslProcessMock.mockRejectedValue(new Error('spawn wsl.exe ENOENT'))

    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])

    expect(found).toEqual(new Set())
  })

  it('skips the probe entirely when no commands are requested', async () => {
    const found = await detectWslCommandsOnPath({ distro: 'Ubuntu' }, [])

    expect(found).toEqual(new Set())
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })
})

it('does not veto a guest binary on an ordinary Linux mount under /mnt', async () => {
  // The walk skips PATH components the guest reports as Windows drives. A name
  // rule on top of that could only do harm: /mnt/d can be an ext4 volume, and
  // vetoing a path the walk deliberately kept turns the false positive back
  // into the #9725 false negative.
  runWslProcessMock.mockResolvedValue({
    environmentResolved: true,
    code: 0,
    stdout: '__ORCA_AGENT_PATH__claude\t/mnt/d/tools/claude\n',
    stderr: '',
    timedOut: false
  })
  await expect(detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])).resolves.toEqual(
    new Set(['claude'])
  )
})

it('still counts a genuine guest install', async () => {
  runWslProcessMock.mockResolvedValue({
    environmentResolved: true,
    code: 0,
    stdout: '__ORCA_AGENT_PATH__claude\t/home/alice/.nvm/versions/node/v20.1.0/bin/claude\n',
    stderr: '',
    timedOut: false
  })
  expect(await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude'])).toEqual(
    new Set(['claude'])
  )
})

describe('the detection script itself, run by a real POSIX shell', () => {
  // Not a mock: the fallback is shell globbing and `[ -x ]`, which only the
  // shell can be trusted about. Skipped on Windows, where /bin/sh is absent.
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
    // #9725: without the login PATH this resolves to nothing and preflight
    // reports a working install as "not installed".
    plant('.nvm/versions/node/v20.1.0/bin', 'orca-fake-cli')
    const out = await runScript()
    expect(out).toContain('__ORCA_AGENT_PATH__orca-fake-cli')
    expect(out).toContain('.nvm/versions/node/v20.1.0/bin/orca-fake-cli')
  })

  itPosix('finds a ~/.local/bin install', async () => {
    plant('.local/bin', 'orca-fake-cli')
    expect(await runScript()).toContain('__ORCA_AGENT_PATH__orca-fake-cli')
  })

  itPosix('still reports nothing for a command that is genuinely absent', async () => {
    plant('.local/bin', 'orca-fake-cli')
    expect(await runScript()).not.toContain('nosuchtool')
  })

  itPosix('finds a CLI when $HOME contains a space', async () => {
    // The dir list is globbed, so an unquoted $HOME word-split into a relative
    // path and every CLI read as absent -- the #9725 symptom, from the fix.
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
    // Directories are mode 755 and pass -x. Preflight would say installed and
    // the launch would fail later with EISDIR.
    mkdirSync(join(home, '.local/bin/orca-fake-cli'), { recursive: true })
    expect(await runScript()).not.toContain('__ORCA_AGENT_PATH__orca-fake-cli')
  })

  itPosix.each([
    '.volta/bin',
    '.asdf/shims',
    '.fnm/aliases/default/bin',
    '.local/share/mise/shims'
  ])('covers %s, which the native fallback also probes', async (dir) => {
    plant(dir, 'orca-fake-cli')
    expect(await runScript()).toContain('__ORCA_AGENT_PATH__orca-fake-cli')
  })
})

describe('the PATH walk, run by a real POSIX shell', () => {
  const itPosix = process.platform === 'win32' ? it.skip : it

  itPosix('finds the guest install behind a Windows binary that shadows it', async () => {
    // WSL appends the Windows PATH, so a Windows `claude` sits ahead of an
    // nvm one. Rejecting the resolved path afterwards cannot resume the walk,
    // so it reports "not installed" for a user who has both -- turning the
    // false positive into the #9725 false negative. Skipping the component
    // mid-walk is what actually finds the guest binary.
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
        // Stand in for /proc/mounts, which a test host does not have.
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
    // The prelude is embedded in the lookup script, which the caller wraps in
    // `for cmd in <every agent>`. An unconditional assignment forked awk once
    // per CLI -- 36 of them inside the distro against a 10s budget.
    expect(await runWithCountingAwk(['claude', 'codex', 'gemini', 'opencode'])).toBe(1)
  })

  itPosix('still reads it once when only one command is probed', async () => {
    expect(await runWithCountingAwk(['claude'])).toBe(1)
  })

  itPosix('applies the memoised mount list to every command, not just the first', async () => {
    // Counting forks with a stub that reports NO mounts cannot see the thing
    // the hoist trades correctness for: a refactor that empties or clobbers
    // the variable inside the walk keeps the fork count at 1 and keeps the
    // single-command test green, while every agent after the first stops
    // skipping /mnt. A surviving mutant proved that gap.
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
      // BOTH must resolve behind the mount, not just the first.
      expect(out).toContain(`__ORCA_AGENT_PATH__claude\t${join(guest, 'claude')}`)
      expect(out).toContain(`__ORCA_AGENT_PATH__codex\t${join(guest, 'codex')}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
