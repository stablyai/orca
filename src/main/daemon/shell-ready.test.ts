import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import type * as ShellReadyModule from './shell-ready'

async function importFreshShellReady(): Promise<typeof ShellReadyModule> {
  vi.resetModules()
  return import('./shell-ready')
}

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('daemon shell-ready launch config', () => {
  let previousUserDataPath: string | undefined
  let userDataPath: string

  beforeEach(() => {
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-shell-ready-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
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
})
