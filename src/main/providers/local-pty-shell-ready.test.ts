/* eslint-disable max-lines -- Why: shell-ready wrapper coverage keeps zsh,
   bash, marker scanning, and env restoration cases in one suite so the
   generated wrapper contract is reviewed as a unit. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import type * as pty from 'node-pty'
import type * as LocalPtyShellReadyModule from './local-pty-shell-ready'
import { writeStartupCommandWhenShellReady } from './local-pty-shell-ready'

const { getUserDataPathMock } = vi.hoisted(() => ({
  getUserDataPathMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return getUserDataPathMock()
      }
      throw new Error(`unexpected app.getPath(${name})`)
    }
  }
}))

async function importFreshLocalPtyShellReady(): Promise<typeof LocalPtyShellReadyModule> {
  vi.resetModules()
  return import('./local-pty-shell-ready')
}

type DataCb = (data: string) => void
type ExitCb = (info: { exitCode: number }) => void

function createMockProc(): pty.IPty & {
  _emitData: (data: string) => void
  _writes: string[]
} {
  let onDataCbs: DataCb[] = []
  const writes: string[] = []
  const fake = {
    pid: 1,
    cols: 80,
    rows: 24,
    process: 'bash',
    handleFlowControl: false,
    write: (data: string) => {
      writes.push(data)
    },
    resize: () => {},
    clear: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    onData: (cb: DataCb) => {
      onDataCbs.push(cb)
      return {
        dispose: () => {
          onDataCbs = onDataCbs.filter((c) => c !== cb)
        }
      }
    },
    onExit: (_cb: ExitCb) => ({ dispose: () => {} }),
    _emitData: (data: string) => {
      for (const cb of onDataCbs.slice()) {
        cb(data)
      }
    },
    _writes: writes
  } as unknown as pty.IPty & { _emitData: (data: string) => void; _writes: string[] }

  return fake
}

describe('writeStartupCommandWhenShellReady', () => {
  let origPlatform: NodeJS.Platform

  beforeEach(() => {
    vi.useFakeTimers()
    origPlatform = process.platform
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: origPlatform })
  })

  it('appends LF on POSIX so bash/zsh submit the line', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude', () => {})

    await ready
    // flush path waits for a post-ready data chunk (prompt draw) then 30ms,
    // or falls back after 50ms if no data arrives.
    vi.advanceTimersByTime(50)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\n'])
  })

  it('appends CR on Windows so PowerShell/cmd.exe submit the line', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude', () => {})

    await ready
    vi.advanceTimersByTime(50)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\r'])
  })

  it('does not re-append a submit byte if the command already ends in CR or LF', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude\n', () => {})

    await ready
    vi.advanceTimersByTime(50)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\n'])
  })
})

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('local PTY shell-ready launch config', () => {
  let userDataPath: string
  let previousOrcaOrigZdotdir: string | undefined

  beforeEach(() => {
    previousOrcaOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    delete process.env.ORCA_ORIG_ZDOTDIR
    userDataPath = mkdtempSync(join(tmpdir(), 'local-pty-shell-ready-test-'))
    getUserDataPathMock.mockReturnValue(userDataPath)
  })

  afterEach(() => {
    if (previousOrcaOrigZdotdir === undefined) {
      delete process.env.ORCA_ORIG_ZDOTDIR
    } else {
      process.env.ORCA_ORIG_ZDOTDIR = previousOrcaOrigZdotdir
    }
    rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('falls back to HOME for ORCA_ORIG_ZDOTDIR when inherited ZDOTDIR points at a wrapper dir', async () => {
    // Why: mirrors the daemon path — guards the same zsh recursion loop for
    // PTYs spawned by the renderer/local provider when Orca is launched from
    // inside an Orca terminal (e.g. `pn dev`).
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('uses inherited ORCA_ORIG_ZDOTDIR when ZDOTDIR is an Orca wrapper dir', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.ORCA_ORIG_ZDOTDIR = '/Users/alice/.config/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice/.config/zsh')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousOrigZdotdir === undefined) {
        delete process.env.ORCA_ORIG_ZDOTDIR
      } else {
        process.env.ORCA_ORIG_ZDOTDIR = previousOrigZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('falls back to HOME when inherited ORCA_ORIG_ZDOTDIR points at a wrapper dir', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    const previousHome = process.env.HOME
    delete process.env.ZDOTDIR
    process.env.ORCA_ORIG_ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousOrigZdotdir === undefined) {
        delete process.env.ORCA_ORIG_ZDOTDIR
      } else {
        process.env.ORCA_ORIG_ZDOTDIR = previousOrigZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('writes zsh wrappers that guard against ORCA_ORIG_ZDOTDIR self-loops', async () => {
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')
    expect(zshenv).toContain('*/shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;')
  })

  it('writes wrappers that restore OpenCode and Pi config after user startup files', async () => {
    const { getBashShellReadyRcfileContent, getShellReadyLaunchConfig } =
      await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshrc = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshrc'), 'utf8')
    const zlogin = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zlogin'), 'utf8')
    const bashRc = getBashShellReadyRcfileContent()
    const restoreLine =
      '[[ -n "${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="${ORCA_OPENCODE_CONFIG_DIR}"'
    const piRestoreLine =
      '[[ -n "${ORCA_PI_CODING_AGENT_DIR:-}" ]] && export PI_CODING_AGENT_DIR="${ORCA_PI_CODING_AGENT_DIR}"'
    expect(zshrc).toContain(restoreLine)
    expect(zlogin).toContain(restoreLine)
    expect(bashRc).toContain(restoreLine)
    expect(zshrc).toContain(piRestoreLine)
    expect(zlogin).toContain(piRestoreLine)
    expect(bashRc).toContain(piRestoreLine)
  })

  it('preserves a real inherited ZDOTDIR as ORCA_ORIG_ZDOTDIR', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    process.env.ZDOTDIR = '/Users/alice/.config/zsh'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice/.config/zsh')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
    }
  })

  it('rejects inherited ZDOTDIR ending in /shell-ready/zsh even with a trailing slash', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh/'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('falls back to HOME when ZDOTDIR is only slashes (e.g. "/")', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('preserves ZDOTDIR that contains /shell-ready/zsh as a substring but does not end with it', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    process.env.ZDOTDIR = '/Users/alice/shell-ready/zsh-custom'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice/shell-ready/zsh-custom')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
    }
  })

  it('writes a zshenv that lets user .zshenv compute its own ZDOTDIR (XDG case)', async () => {
    // Why: the bug being fixed is that the old wrapper captured ORCA_ORIG_ZDOTDIR
    // before user .zshenv ran, so XDG-layout users (where .zshenv sets ZDOTDIR
    // to ~/.config/zsh) ended up sourcing ~/.zshrc instead of the real one.
    // Pin the new template's three load-bearing lines so a future refactor
    // can't silently regress the contract.
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')
    expect(zshenv).toContain('unset ZDOTDIR')
    expect(zshenv).toContain('__orca_source_user_zshenv()')
    expect(zshenv).toContain(
      'export ORCA_ORIG_ZDOTDIR="${ZDOTDIR:-${_orca_spawn_orig_zdotdir:-$HOME}}"'
    )
    // Why: re-pin must use the baked wrapper dir, not $ORCA_ORIG_ZDOTDIR — a
    // captured-from-spawn-env approach would be empty if a caller forgot to
    // set ZDOTDIR in the spawn env.
    expect(zshenv).toContain(`export ZDOTDIR='${join(userDataPath, 'shell-ready', 'zsh')}'`)
  })

  it('attribution launch config produces the same zsh wrapper content', async () => {
    // Why: getAttributionShellLaunchConfig is a separate public entry point
    // (used for attribution-shim PTYs that don't emit the ready marker).
    // It must go through the same ensureShellReadyWrappers path, so the
    // wrapper files on disk are identical and the XDG fix applies there too.
    const { getShellReadyLaunchConfig, getAttributionShellLaunchConfig } =
      await importFreshLocalPtyShellReady()

    const ready = getShellReadyLaunchConfig('/bin/zsh')
    const zshenvAfterReady = readFileSync(
      join(userDataPath, 'shell-ready', 'zsh', '.zshenv'),
      'utf8'
    )

    const attribution = getAttributionShellLaunchConfig('/bin/zsh')
    const zshenvAfterAttribution = readFileSync(
      join(userDataPath, 'shell-ready', 'zsh', '.zshenv'),
      'utf8'
    )

    expect(zshenvAfterAttribution).toBe(zshenvAfterReady)
    expect(attribution.env.ZDOTDIR).toBe(ready.env.ZDOTDIR)
    expect(attribution.env.ORCA_ORIG_ZDOTDIR).toBe(ready.env.ORCA_ORIG_ZDOTDIR)
    expect(attribution.env.ORCA_SHELL_READY_MARKER).toBe('0')
    expect(attribution.supportsReadyMarker).toBe(false)
  })
})

const zshBinary = (() => {
  const result = spawnSync('zsh', ['-c', 'echo zsh-ok'])
  return result.status === 0 ? 'zsh' : null
})()

const describeWithZsh =
  process.platform === 'win32' || zshBinary === null ? describe.skip : describe

describeWithZsh('local PTY shell-ready wrapper sourced by real zsh', () => {
  let userDataPath: string
  let homeDir: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'local-pty-shell-ready-zsh-test-'))
    homeDir = mkdtempSync(join(tmpdir(), 'local-pty-shell-ready-zsh-home-'))
    mkdirSync(join(homeDir, '.config', 'zsh'), { recursive: true })
    getUserDataPathMock.mockReturnValue(userDataPath)
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function runWrapperZshenv(env: Record<string, string>): { stdout: string; stderr: string } {
    const wrapperZdotdir = join(userDataPath, 'shell-ready', 'zsh')
    // Why: env -i would also work but is harder to drive cross-platform from
    // Node. Pass an explicit env that only carries what the wrapper needs,
    // so the parent process's XDG_CONFIG_HOME / ZDOTDIR don't leak through
    // the user's .zshenv default-expansion idioms.
    const result = spawnSync(
      zshBinary as string,
      [
        '-f',
        '-c',
        `source "$ZDOTDIR/.zshenv"; printf 'ZDOTDIR=%s\\nORCA_ORIG_ZDOTDIR=%s\\n' "$ZDOTDIR" "$ORCA_ORIG_ZDOTDIR"`
      ],
      {
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          HOME: homeDir,
          ZDOTDIR: wrapperZdotdir,
          ...env
        },
        encoding: 'utf8'
      }
    )
    if (result.status !== 0) {
      throw new Error(`zsh exited ${result.status}: ${result.stderr}`)
    }
    return { stdout: result.stdout, stderr: result.stderr }
  }

  it('captures the XDG-resolved ZDOTDIR into ORCA_ORIG_ZDOTDIR', async () => {
    // Why: real-zsh proof of the bug fix. With the old wrapper, ORCA_ORIG_ZDOTDIR
    // would end up at $HOME because user .zshenv ran AFTER the capture.
    writeFileSync(
      join(homeDir, '.zshenv'),
      'export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"\n' +
        'export ZDOTDIR="${ZDOTDIR:-$XDG_CONFIG_HOME/zsh}"\n',
      'utf8'
    )
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
    getShellReadyLaunchConfig('/bin/zsh')

    const { stdout } = runWrapperZshenv({})

    expect(stdout).toContain(`ZDOTDIR=${join(userDataPath, 'shell-ready', 'zsh')}\n`)
    expect(stdout).toContain(`ORCA_ORIG_ZDOTDIR=${join(homeDir, '.config', 'zsh')}\n`)
  })

  it('survives early-return in user .zshenv and still re-pins ZDOTDIR to the wrapper', async () => {
    // Why: user dotfiles often guard expensive .zshenv setup with an early
    // return (`[[ -o interactive ]] || return`, `[[ -n $TMUX ]] && return`,
    // etc.). Without the function wrapper, that return would exit our
    // wrapper .zshenv too — leaving ZDOTDIR unset and breaking the OSC 133;A
    // ready-marker contract.
    writeFileSync(join(homeDir, '.zshenv'), 'return 0\nexport ZDOTDIR=/never/reached\n', 'utf8')
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
    getShellReadyLaunchConfig('/bin/zsh')

    const { stdout } = runWrapperZshenv({ ORCA_ORIG_ZDOTDIR: homeDir })

    expect(stdout).toContain(`ZDOTDIR=${join(userDataPath, 'shell-ready', 'zsh')}\n`)
    // spawn-env ORCA_ORIG_ZDOTDIR survives the early return.
    expect(stdout).toContain(`ORCA_ORIG_ZDOTDIR=${homeDir}\n`)
  })

  it('preserves spawn-env ORCA_ORIG_ZDOTDIR when user .zshenv does not set ZDOTDIR', async () => {
    writeFileSync(join(homeDir, '.zshenv'), 'export FOO=bar\n', 'utf8')
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
    getShellReadyLaunchConfig('/bin/zsh')

    const customZdotdir = join(homeDir, '.config', 'zsh')
    const { stdout } = runWrapperZshenv({ ORCA_ORIG_ZDOTDIR: customZdotdir })

    expect(stdout).toContain(`ORCA_ORIG_ZDOTDIR=${customZdotdir}\n`)
  })

  it('falls back to HOME when neither user .zshenv nor spawn env set ORCA_ORIG_ZDOTDIR', async () => {
    writeFileSync(join(homeDir, '.zshenv'), '\n', 'utf8')
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
    getShellReadyLaunchConfig('/bin/zsh')

    // No ORCA_ORIG_ZDOTDIR in spawn env, and ORCA_ORIG_ZDOTDIR will be
    // empty after `_orca_spawn_orig_zdotdir="${ORCA_ORIG_ZDOTDIR:-}"`.
    // Forcing it absent with empty string mimics the unset case at this layer.
    const { stdout } = runWrapperZshenv({ ORCA_ORIG_ZDOTDIR: '' })

    expect(stdout).toContain(`ORCA_ORIG_ZDOTDIR=${homeDir}\n`)
  })

  it('normalizes a self-loop ORCA_ORIG_ZDOTDIR back to HOME at runtime', async () => {
    // Why: pairs with the Node-side normalizer test above, but covers the
    // case where user .zshenv exports a wrapper-shaped ZDOTDIR itself
    // (e.g. by echoing back an inherited one).
    const fakeWrapper = '/some/other/orca/shell-ready/zsh'
    writeFileSync(join(homeDir, '.zshenv'), `export ZDOTDIR='${fakeWrapper}'\n`, 'utf8')
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
    getShellReadyLaunchConfig('/bin/zsh')

    const { stdout } = runWrapperZshenv({})

    expect(stdout).toContain(`ORCA_ORIG_ZDOTDIR=${homeDir}\n`)
  })

  it('normalizes a wrapper-shaped ZDOTDIR with multiple trailing slashes', async () => {
    // Why: matches the Node-side normalizer that strips all trailing slashes.
    // Without the loop in the wrapper, `${var%/}` only strips one and the
    // suffix check misses, restoring the recursion bug.
    const fakeWrapper = '/some/other/orca/shell-ready/zsh///'
    writeFileSync(join(homeDir, '.zshenv'), `export ZDOTDIR='${fakeWrapper}'\n`, 'utf8')
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
    getShellReadyLaunchConfig('/bin/zsh')

    const { stdout } = runWrapperZshenv({})

    expect(stdout).toContain(`ORCA_ORIG_ZDOTDIR=${homeDir}\n`)
  })
})
