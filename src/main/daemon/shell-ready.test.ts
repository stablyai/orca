/* eslint-disable max-lines -- Why: daemon shell-ready coverage keeps the
   zsh/bash launch config, durable wrapper rcfile generation, env
   normalization, and real-zsh wrapper validation in one suite so the
   generated wrapper contract is reviewed as a unit. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import type * as ShellReadyModule from './shell-ready'

async function importFreshShellReady(): Promise<typeof ShellReadyModule> {
  vi.resetModules()
  return import('./shell-ready')
}

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('daemon shell-ready launch config', () => {
  let previousUserDataPath: string | undefined
  let previousOrcaOrigZdotdir: string | undefined
  let userDataPath: string

  beforeEach(() => {
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    previousOrcaOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    delete process.env.ORCA_ORIG_ZDOTDIR
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-shell-ready-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    if (previousOrcaOrigZdotdir === undefined) {
      delete process.env.ORCA_ORIG_ZDOTDIR
    } else {
      process.env.ORCA_ORIG_ZDOTDIR = previousOrcaOrigZdotdir
    }
    rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('stores wrapper rcfiles under durable userData instead of tmp', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    const config = getShellReadyLaunchConfig('/bin/bash')
    const rcfile = join(userDataPath, 'shell-ready', 'bash', 'rcfile')

    expect(config.args).toEqual(['--rcfile', rcfile])
    expect(existsSync(rcfile)).toBe(true)
  })

  it('rewrites wrappers when a long-lived daemon finds a missing rcfile', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()
    const rcfile = join(userDataPath, 'shell-ready', 'bash', 'rcfile')

    getShellReadyLaunchConfig('/bin/bash')
    rmSync(rcfile)

    expect(existsSync(rcfile)).toBe(false)
    getShellReadyLaunchConfig('/bin/bash')
    expect(existsSync(rcfile)).toBe(true)
  })

  it('points zsh launch config at durable wrapper files', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    const config = getShellReadyLaunchConfig('/bin/zsh')

    expect(config.args).toEqual(['-l'])
    expect(config.env.ZDOTDIR).toBe(join(userDataPath, 'shell-ready', 'zsh'))
    expect(existsSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'))).toBe(true)
  })

  it('falls back to HOME for ORCA_ORIG_ZDOTDIR when inherited ZDOTDIR points at a wrapper dir', async () => {
    // Why: guards against the zsh recursion loop that happens when the daemon
    // was forked from a shell which was itself an Orca PTY. Such a shell has
    // ZDOTDIR=<some>/shell-ready/zsh; propagating that unchanged would make
    // the wrapper `source "$ORCA_ORIG_ZDOTDIR/.zshenv"` source itself.
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')
    expect(zshenv).toContain('*/shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;')
  })

  it('writes wrappers that restore OpenCode and Pi config after user startup files', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    getShellReadyLaunchConfig('/bin/zsh')
    getShellReadyLaunchConfig('/bin/bash')

    const zshrc = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshrc'), 'utf8')
    const zlogin = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zlogin'), 'utf8')
    const bashRc = readFileSync(join(userDataPath, 'shell-ready', 'bash', 'rcfile'), 'utf8')
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
    // Why: users who run a custom zsh dotfiles directory legitimately set
    // ZDOTDIR before launching Orca. We only want to reject the self-loop
    // case — any real user ZDOTDIR must round-trip so their configs load.
    const previousZdotdir = process.env.ZDOTDIR
    process.env.ZDOTDIR = '/Users/alice/.config/zsh'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    // Why: `endsWith('/shell-ready/zsh')` without normalization is bypassed by
    // a trailing slash, which some shell startup scripts add. Pinning this case
    // guards against a regression that would reintroduce the recursion loop.
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh/'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    // Why: a bare `/` (or `////`) normalizes to empty and is never a user's
    // real zsh config root; sourcing `/.zshenv` would silently no-op. Falling
    // back to HOME matches what the wrapper already assumes when ZDOTDIR is
    // unset.
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    // Why: the guard must match the suffix, not a substring — a user directory
    // like `/Users/alice/shell-ready/zsh-custom` should round-trip unchanged.
    // Pinning this case prevents an over-eager `includes` swap in the future.
    const previousZdotdir = process.env.ZDOTDIR
    process.env.ZDOTDIR = '/Users/alice/shell-ready/zsh-custom'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    const { getShellReadyLaunchConfig } = await importFreshShellReady()
    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')
    expect(zshenv).toContain('unset ZDOTDIR')
    expect(zshenv).toContain('__orca_source_user_zshenv()')
    expect(zshenv).toContain(
      'export ORCA_ORIG_ZDOTDIR="${ZDOTDIR:-${_orca_spawn_orig_zdotdir:-$HOME}}"'
    )
    expect(zshenv).toContain(`export ZDOTDIR='${join(userDataPath, 'shell-ready', 'zsh')}'`)
  })

  it('attribution launch config produces the same zsh wrapper content', async () => {
    // Why: getAttributionShellLaunchConfig is a separate public entry point
    // (used for attribution-shim PTYs that don't emit the ready marker).
    // It must go through the same ensureShellReadyWrappers path, so the
    // wrapper files on disk are identical and the XDG fix applies there too.
    const { getShellReadyLaunchConfig, getAttributionShellLaunchConfig } =
      await importFreshShellReady()

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

describeWithZsh('daemon shell-ready wrapper sourced by real zsh', () => {
  let previousUserDataPath: string | undefined
  let userDataPath: string
  let homeDir: string

  beforeEach(() => {
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-shell-ready-zsh-test-'))
    homeDir = mkdtempSync(join(tmpdir(), 'daemon-shell-ready-zsh-home-'))
    mkdirSync(join(homeDir, '.config', 'zsh'), { recursive: true })
    process.env.ORCA_USER_DATA_PATH = userDataPath
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function runWrapperZshenv(env: Record<string, string>): { stdout: string; stderr: string } {
    const wrapperZdotdir = join(userDataPath, 'shell-ready', 'zsh')
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
    writeFileSync(
      join(homeDir, '.zshenv'),
      'export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"\n' +
        'export ZDOTDIR="${ZDOTDIR:-$XDG_CONFIG_HOME/zsh}"\n',
      'utf8'
    )
    const { getShellReadyLaunchConfig } = await importFreshShellReady()
    getShellReadyLaunchConfig('/bin/zsh')

    const { stdout } = runWrapperZshenv({})

    expect(stdout).toContain(`ZDOTDIR=${join(userDataPath, 'shell-ready', 'zsh')}\n`)
    expect(stdout).toContain(`ORCA_ORIG_ZDOTDIR=${join(homeDir, '.config', 'zsh')}\n`)
  })

  it('survives early-return in user .zshenv and still re-pins ZDOTDIR to the wrapper', async () => {
    writeFileSync(join(homeDir, '.zshenv'), 'return 0\nexport ZDOTDIR=/never/reached\n', 'utf8')
    const { getShellReadyLaunchConfig } = await importFreshShellReady()
    getShellReadyLaunchConfig('/bin/zsh')

    const { stdout } = runWrapperZshenv({ ORCA_ORIG_ZDOTDIR: homeDir })

    expect(stdout).toContain(`ZDOTDIR=${join(userDataPath, 'shell-ready', 'zsh')}\n`)
    expect(stdout).toContain(`ORCA_ORIG_ZDOTDIR=${homeDir}\n`)
  })

  it('preserves spawn-env ORCA_ORIG_ZDOTDIR when user .zshenv does not set ZDOTDIR', async () => {
    writeFileSync(join(homeDir, '.zshenv'), 'export FOO=bar\n', 'utf8')
    const { getShellReadyLaunchConfig } = await importFreshShellReady()
    getShellReadyLaunchConfig('/bin/zsh')

    const customZdotdir = join(homeDir, '.config', 'zsh')
    const { stdout } = runWrapperZshenv({ ORCA_ORIG_ZDOTDIR: customZdotdir })

    expect(stdout).toContain(`ORCA_ORIG_ZDOTDIR=${customZdotdir}\n`)
  })

  it('normalizes a wrapper-shaped ZDOTDIR with multiple trailing slashes', async () => {
    // Why: matches the Node-side normalizer that strips all trailing slashes.
    // Without the loop in the wrapper, `${var%/}` only strips one and the
    // suffix check misses, restoring the recursion bug.
    const fakeWrapper = '/some/other/orca/shell-ready/zsh///'
    writeFileSync(join(homeDir, '.zshenv'), `export ZDOTDIR='${fakeWrapper}'\n`, 'utf8')
    const { getShellReadyLaunchConfig } = await importFreshShellReady()
    getShellReadyLaunchConfig('/bin/zsh')

    const { stdout } = runWrapperZshenv({})

    expect(stdout).toContain(`ORCA_ORIG_ZDOTDIR=${homeDir}\n`)
  })
})
