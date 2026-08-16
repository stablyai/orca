import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, readFileSyncMock, readdirSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  readdirSyncMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  readdirSync: readdirSyncMock
}))

import {
  __resetShellStartupEnvCache,
  isShellStartupEnvProbeSupported,
  readSessionShellStartupEnvVar,
  readShellStartupEnvVar
} from './shell-startup-env'

describe('readShellStartupEnvVar', () => {
  const originalPlatform = process.platform
  const originalShell = process.env.SHELL
  // Why pinned: the fish branch defaults configHome to process.env.XDG_CONFIG_HOME, which CI
  // runners set and dev machines usually do not — leaving it ambient makes these mocked paths
  // resolve differently per host.
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

  beforeEach(() => {
    delete process.env.XDG_CONFIG_HOME
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    readdirSyncMock.mockReset()
    // Why: only the fish branch lists a directory; every other case must see ENOENT.
    readdirSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    process.env.SHELL = '/bin/zsh'
    __resetShellStartupEnvCache()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    if (originalShell === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = originalShell
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    }
  })

  function mockStartupFiles(files: Record<string, string>) {
    const hasAbsoluteKeys = Object.keys(files).some((path) => path.startsWith('/'))
    existsSyncMock.mockImplementation((p: string) => {
      const file = p.split('/').pop() ?? ''
      return p in files || (!hasAbsoluteKeys && file in files)
    })
    readFileSyncMock.mockImplementation((p: string) => {
      const file = p.split('/').pop() ?? ''
      if (p in files) {
        return files[p]
      }
      if (!hasAbsoluteKeys && file in files) {
        return files[file]
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
  }

  // Issue #1534 / PR description: GUI-launched Orca does not inherit
  // OPENCODE_CONFIG_DIR; the user's .zshrc exports it. The fallback must
  // pick up that export so the overlay mirrors the user's real config.
  // Scope: this intentionally covers direct static exports; sourced files,
  // conditionals, and full shell evaluation remain out of scope.
  it('mirrors the user scenario: GUI-launched Orca discovers .zshrc-only export', () => {
    mockStartupFiles({
      '.zshrc': 'export OPENCODE_CONFIG_DIR="$HOME/.config/opencode"\n'
    })

    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe(
      '/home/alice/.config/opencode'
    )
  })

  it('returns undefined when HOME is unset', () => {
    const savedHome = process.env.HOME
    delete process.env.HOME
    try {
      expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR')).toBeUndefined()
      expect(existsSyncMock).not.toHaveBeenCalled()
    } finally {
      if (savedHome !== undefined) {
        process.env.HOME = savedHome
      }
    }
  })

  it('returns undefined on Windows', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mockStartupFiles({ '.zshrc': 'export OPENCODE_CONFIG_DIR=/win\n' })
    expect(isShellStartupEnvProbeSupported()).toBe(false)
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBeUndefined()
  })

  it('reports startup-env probing as supported on macOS and Linux', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
      expect(isShellStartupEnvProbeSupported()).toBe(true)
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      expect(isShellStartupEnvProbeSupported()).toBe(true)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('returns undefined when no startup file matches', () => {
    mockStartupFiles({ '.zshrc': 'export FOO=bar\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBeUndefined()
  })

  it('returns the LAST assignment when multiple files re-export', () => {
    mockStartupFiles({
      '.zshenv': 'export OPENCODE_CONFIG_DIR="/old/zshenv"\n',
      '.zprofile': 'export OPENCODE_CONFIG_DIR="/middle/zprofile"\n',
      '.zshrc': 'export OPENCODE_CONFIG_DIR="/new/zshrc"\n',
      '.zlogin': 'export OPENCODE_CONFIG_DIR="/newest/zlogin"\n'
    })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/newest/zlogin')
  })

  it('uses ZDOTDIR exported from .zshenv for later zsh startup files', () => {
    mockStartupFiles({
      '/home/alice/.zshenv': 'export ZDOTDIR="$HOME/.config/zsh"\n',
      '/home/alice/.config/zsh/.zshrc': 'export OPENCODE_CONFIG_DIR="$HOME/company/opencode"\n'
    })

    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice', '/bin/zsh')).toBe(
      '/home/alice/company/opencode'
    )
  })

  it('handles double-quoted values', () => {
    mockStartupFiles({ '.zshrc': 'export OPENCODE_CONFIG_DIR="/quoted/path"\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/quoted/path')
  })

  it('handles single-quoted values', () => {
    mockStartupFiles({ '.zshrc': "export OPENCODE_CONFIG_DIR='/quoted/path'\n" })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/quoted/path')
  })

  it('handles unquoted values', () => {
    mockStartupFiles({ '.zshrc': 'export OPENCODE_CONFIG_DIR=/unquoted/path\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/unquoted/path')
  })

  it('expands $HOME in values', () => {
    mockStartupFiles({ '.zshrc': 'export OPENCODE_CONFIG_DIR="$HOME/.opencode"\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe(
      '/home/alice/.opencode'
    )
  })

  it('expands ${HOME} in values', () => {
    mockStartupFiles({ '.zshrc': 'export OPENCODE_CONFIG_DIR="${HOME}/.opencode"\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe(
      '/home/alice/.opencode'
    )
  })

  it('expands leading ~ in values', () => {
    mockStartupFiles({ '.zshrc': 'export OPENCODE_CONFIG_DIR=~/.opencode\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe(
      '/home/alice/.opencode'
    )
  })

  it('ignores bare assignments without the export keyword', () => {
    // Why: POSIX `FOO=bar` (no export) creates a shell-local variable that
    // is NOT inherited by child processes. The PTY child shell would never
    // see this value, so we should not mirror it as a "source" for overlay
    // construction.
    mockStartupFiles({ '.zshrc': 'OPENCODE_CONFIG_DIR=/no/export\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBeUndefined()
  })

  it('preserves a # inside a double-quoted value', () => {
    // Why: shells treat # as a comment delimiter only when it begins a word
    // (preceded by whitespace). Inside quotes it's literal.
    mockStartupFiles({ '.zshrc': 'export OPENCODE_CONFIG_DIR="/path/with#hash"\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/path/with#hash')
  })

  it('preserves a # inside a single-quoted value', () => {
    mockStartupFiles({ '.zshrc': "export OPENCODE_CONFIG_DIR='/path/with#hash'\n" })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/path/with#hash')
  })

  it('strips a trailing # comment from an unquoted value', () => {
    mockStartupFiles({ '.zshrc': 'export OPENCODE_CONFIG_DIR=/bare/path # trailing comment\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/bare/path')
  })

  it('strips a trailing # comment after a double-quoted value', () => {
    mockStartupFiles({
      '.zshrc': 'export OPENCODE_CONFIG_DIR="$HOME/.opencode" # trailing comment\n'
    })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe(
      '/home/alice/.opencode'
    )
  })

  it('strips a trailing # comment after a single-quoted value', () => {
    mockStartupFiles({
      '.zshrc': "export OPENCODE_CONFIG_DIR='/literal/path' # trailing comment\n"
    })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/literal/path')
  })

  it('does not expand $HOME inside single quotes', () => {
    // Why: POSIX shells do not perform parameter expansion in single quotes.
    mockStartupFiles({ '.zshrc': "export OPENCODE_CONFIG_DIR='$HOME/.opencode'\n" })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('$HOME/.opencode')
  })

  it('does not partially expand $HOMER / $HOMEPATH', () => {
    // Why: real shells require a word boundary; $HOMER is the var HOMER,
    // not $HOME + R.
    mockStartupFiles({ '.zshrc': 'export OPENCODE_CONFIG_DIR="$HOMER/agent"\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('$HOMER/agent')
  })

  it('only scans zsh startup files when SHELL is zsh', () => {
    // Why: a stale .bash_profile on a zsh user must NOT clobber the value
    // from .zshrc, since the live shell would never source .bash_profile.
    process.env.SHELL = '/bin/zsh'
    mockStartupFiles({
      '.zshrc': 'export OPENCODE_CONFIG_DIR=/from/zshrc\n',
      '.bash_profile': 'export OPENCODE_CONFIG_DIR=/from/bash_profile\n'
    })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/from/zshrc')
  })

  it('only scans bash startup files when SHELL is bash', () => {
    process.env.SHELL = '/bin/bash'
    mockStartupFiles({
      '.zshrc': 'export OPENCODE_CONFIG_DIR=/from/zshrc\n',
      '.bash_profile': 'export OPENCODE_CONFIG_DIR=/from/bash_profile\n'
    })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/from/bash_profile')
  })

  it('defaults to zsh startup files when SHELL is unset', () => {
    delete process.env.SHELL
    mockStartupFiles({
      '.zshrc': 'export OPENCODE_CONFIG_DIR=/from/zshrc\n',
      '.bash_profile': 'export OPENCODE_CONFIG_DIR=/from/bash_profile\n'
    })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/from/zshrc')
  })

  it('does not scan .bashrc for bash shells', () => {
    // Why: Orca launches bash as a login shell and the shell-ready wrappers
    // intentionally do NOT source .bashrc, so a value present only in .bashrc
    // would never be set in the live Orca bash shell.
    process.env.SHELL = '/bin/bash'
    mockStartupFiles({ '.bashrc': 'export OPENCODE_CONFIG_DIR=/from/bashrc\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBeUndefined()
  })

  it('does not scan zsh or bash files for an explicit unsupported shell', () => {
    mockStartupFiles({
      '.zshrc': 'export OPENCODE_CONFIG_DIR=/from/zshrc\n',
      '.bash_profile': 'export OPENCODE_CONFIG_DIR=/from/bash_profile\n'
    })
    expect(
      readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice', '/opt/bin/fish')
    ).toBeUndefined()
  })

  it('honors an explicit shell argument over process.env.SHELL', () => {
    // Why: callers (pty.ts) may know the per-spawn SHELL from baseEnv that
    // differs from the Orca process's own $SHELL.
    process.env.SHELL = '/bin/zsh'
    mockStartupFiles({
      '.zshrc': 'export OPENCODE_CONFIG_DIR=/from/zshrc\n',
      '.bash_profile': 'export OPENCODE_CONFIG_DIR=/from/bash_profile\n'
    })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice', '/bin/bash')).toBe(
      '/from/bash_profile'
    )
  })

  it('memoizes results across calls within the same process', () => {
    mockStartupFiles({ '.zshrc': 'export OPENCODE_CONFIG_DIR=/cached\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/cached')

    const callsAfterFirst = readFileSyncMock.mock.calls.length
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/cached')
    expect(readFileSyncMock.mock.calls.length).toBe(callsAfterFirst)
  })

  it('rejects names with regex metacharacters', () => {
    mockStartupFiles({ '.zshrc': 'export FOO=/x\n' })
    expect(readShellStartupEnvVar('FOO.*', '/home/alice')).toBeUndefined()
  })

  it('does not match other variable names', () => {
    mockStartupFiles({
      '.zshrc': 'export OPENCODE_CONFIG_DIR_BACKUP=/backup\nexport NOT_OPENCODE_CONFIG_DIR=/x\n'
    })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBeUndefined()
  })

  it('survives a readFileSync error on one file and continues', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockImplementation((p: string) => {
      if (p.endsWith('.zshenv')) {
        throw new Error('EACCES')
      }
      if (p.endsWith('.zshrc')) {
        return 'export OPENCODE_CONFIG_DIR=/found\n'
      }
      return ''
    })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/found')
  })

  it('handles CRLF line endings', () => {
    mockStartupFiles({ '.zshrc': 'export OPENCODE_CONFIG_DIR=/crlf\r\nexport OTHER=x\r\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBe('/crlf')
  })

  it('does not match an OPENCODE_CONFIG_DIR mention in a comment', () => {
    mockStartupFiles({ '.zshrc': '# export OPENCODE_CONFIG_DIR=/from-comment\n' })
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBeUndefined()
  })

  describe('fish', () => {
    const FISH = '/opt/homebrew/bin/fish'

    function mockFishFiles(files: Record<string, string>, snippets: string[] = []) {
      readdirSyncMock.mockImplementation((dir: string) => {
        if (dir === '/home/alice/.config/fish/conf.d' || dir === '/cfg/fish/conf.d') {
          return snippets
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      mockStartupFiles(files)
    }

    it('reads an exported set from config.fish', () => {
      mockFishFiles({
        '/home/alice/.config/fish/config.fish': 'set -gx CODEX_HOME /home/alice/.codex\n'
      })
      expect(readShellStartupEnvVar('CODEX_HOME', '/home/alice', FISH)).toBe('/home/alice/.codex')
    })

    it('lets config.fish win over a conf.d snippet, matching fish source order', () => {
      mockFishFiles(
        {
          '/home/alice/.config/fish/conf.d/10-agents.fish': 'set -gx CODEX_HOME /from/confd\n',
          '/home/alice/.config/fish/config.fish': 'set -gx CODEX_HOME /from/config\n'
        },
        ['10-agents.fish']
      )
      expect(readShellStartupEnvVar('CODEX_HOME', '/home/alice', FISH)).toBe('/from/config')
    })

    it('sources conf.d snippets in filename order', () => {
      mockFishFiles(
        {
          '/home/alice/.config/fish/conf.d/aaa.fish': 'set -gx CODEX_HOME /from/aaa\n',
          '/home/alice/.config/fish/conf.d/zzz.fish': 'set -gx CODEX_HOME /from/zzz\n'
        },
        ['zzz.fish', 'aaa.fish', 'notes.txt']
      )
      expect(readShellStartupEnvVar('CODEX_HOME', '/home/alice', FISH)).toBe('/from/zzz')
    })

    it('honors XDG_CONFIG_HOME', () => {
      mockFishFiles({ '/cfg/fish/config.fish': 'set -gx CODEX_HOME /from/xdg\n' })
      expect(readShellStartupEnvVar('CODEX_HOME', '/home/alice', FISH, '/cfg')).toBe('/from/xdg')
    })

    // Why also via the env: the argument defaults to process.env.XDG_CONFIG_HOME, so without
    // this every other fish case here silently depends on the host not exporting it.
    it('defaults configHome to XDG_CONFIG_HOME from the environment', () => {
      process.env.XDG_CONFIG_HOME = '/cfg'
      __resetShellStartupEnvCache()
      mockFishFiles({ '/cfg/fish/config.fish': 'set -gx CODEX_HOME /from/env-xdg\n' })
      expect(readShellStartupEnvVar('CODEX_HOME', '/home/alice', FISH)).toBe('/from/env-xdg')
    })

    it('ignores sets that are not exported', () => {
      mockFishFiles({
        '/home/alice/.config/fish/config.fish':
          'set -g CODEX_HOME /global\nset -l CODEX_HOME /local\nset CODEX_HOME /plain\n'
      })
      expect(readShellStartupEnvVar('CODEX_HOME', '/home/alice', FISH)).toBeUndefined()
    })

    it('accepts every fish export spelling', () => {
      for (const line of [
        'set -x CODEX_HOME /a',
        'set -xg CODEX_HOME /a',
        'set -gx CODEX_HOME /a',
        'set -Ux CODEX_HOME /a',
        'set --export --global CODEX_HOME /a'
      ]) {
        __resetShellStartupEnvCache()
        mockFishFiles({ '/home/alice/.config/fish/config.fish': `${line}\n` })
        expect(readShellStartupEnvVar('CODEX_HOME', '/home/alice', FISH)).toBe('/a')
      }
    })

    it('expands $HOME in double quotes and keeps single quotes literal', () => {
      mockFishFiles({
        '/home/alice/.config/fish/config.fish': 'set -gx CODEX_HOME "$HOME/.codex" # note\n'
      })
      expect(readShellStartupEnvVar('CODEX_HOME', '/home/alice', FISH)).toBe('/home/alice/.codex')

      __resetShellStartupEnvCache()
      mockFishFiles({
        '/home/alice/.config/fish/config.fish': "set -gx CODEX_HOME '$HOME/.codex'\n"
      })
      expect(readShellStartupEnvVar('CODEX_HOME', '/home/alice', FISH)).toBe('$HOME/.codex')
    })

    it('does not read zsh or bash startup files for a fish user', () => {
      mockFishFiles({
        '/home/alice/.zshrc': 'export CODEX_HOME=/from/zsh\n',
        '/home/alice/.bash_profile': 'export CODEX_HOME=/from/bash\n'
      })
      expect(readShellStartupEnvVar('CODEX_HOME', '/home/alice', FISH)).toBeUndefined()
    })

    it('ignores a commented assignment', () => {
      mockFishFiles({
        '/home/alice/.config/fish/config.fish': '# set -gx CODEX_HOME /from-comment\n'
      })
      expect(readShellStartupEnvVar('CODEX_HOME', '/home/alice', FISH)).toBeUndefined()
    })

    it('does not match a different variable with the same prefix', () => {
      mockFishFiles({
        '/home/alice/.config/fish/config.fish': 'set -gx CODEX_HOME_BACKUP /backup\n'
      })
      expect(readShellStartupEnvVar('CODEX_HOME', '/home/alice', FISH)).toBeUndefined()
    })
  })

  // Why these matter: a caller that plumbs HOME/SHELL but forgets XDG_CONFIG_HOME
  // reads a different fish config than the shell will, so the same user gets one
  // answer locally and another over relay.
  describe('readSessionShellStartupEnvVar', () => {
    const FISH = '/opt/homebrew/bin/fish'
    const savedConfigHome = process.env.XDG_CONFIG_HOME
    const savedHome = process.env.HOME

    afterEach(() => {
      restoreEnv('XDG_CONFIG_HOME', savedConfigHome)
      restoreEnv('HOME', savedHome)
    })

    function restoreEnv(key: string, value: string | undefined) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }

    it("prefers the session env's XDG_CONFIG_HOME over the main process's", () => {
      process.env.XDG_CONFIG_HOME = '/main-process-cfg'
      mockStartupFiles({
        '/session-cfg/fish/config.fish': 'set -gx CODEX_HOME /from/session\n',
        '/main-process-cfg/fish/config.fish': 'set -gx CODEX_HOME /from/main-process\n'
      })

      expect(
        readSessionShellStartupEnvVar('CODEX_HOME', {
          HOME: '/home/alice',
          SHELL: FISH,
          XDG_CONFIG_HOME: '/session-cfg'
        })
      ).toBe('/from/session')
    })

    it('falls back to the main process XDG_CONFIG_HOME when the session env lacks one', () => {
      process.env.XDG_CONFIG_HOME = '/main-process-cfg'
      mockStartupFiles({
        '/main-process-cfg/fish/config.fish': 'set -gx CODEX_HOME /from/main-process\n'
      })

      expect(
        readSessionShellStartupEnvVar('CODEX_HOME', { HOME: '/home/alice', SHELL: FISH })
      ).toBe('/from/main-process')
    })

    it("falls back to fish's own ~/.config default when neither env has one", () => {
      delete process.env.XDG_CONFIG_HOME
      mockStartupFiles({
        '/home/alice/.config/fish/config.fish': 'set -gx CODEX_HOME /from/default\n'
      })

      expect(
        readSessionShellStartupEnvVar('CODEX_HOME', { HOME: '/home/alice', SHELL: FISH })
      ).toBe('/from/default')
    })

    it('resolves against the session HOME, not the main process HOME', () => {
      delete process.env.XDG_CONFIG_HOME
      process.env.HOME = '/home/root-user'
      mockStartupFiles({
        '/home/alice/.config/fish/config.fish': 'set -gx CODEX_HOME "$HOME/.codex"\n',
        '/home/root-user/.config/fish/config.fish': 'set -gx CODEX_HOME /from/wrong-home\n'
      })

      expect(
        readSessionShellStartupEnvVar('CODEX_HOME', { HOME: '/home/alice', SHELL: FISH })
      ).toBe('/home/alice/.codex')
    })

    it('lets an explicit shell override beat the session SHELL', () => {
      delete process.env.XDG_CONFIG_HOME
      mockStartupFiles({
        '/home/alice/.config/fish/config.fish': 'set -gx CODEX_HOME /from/fish\n',
        '/home/alice/.zshrc': 'export CODEX_HOME=/from/zsh\n'
      })

      expect(
        readSessionShellStartupEnvVar(
          'CODEX_HOME',
          { HOME: '/home/alice', SHELL: '/bin/zsh' },
          FISH
        )
      ).toBe('/from/fish')
    })

    it('falls back to the main process HOME and SHELL with no session env at all', () => {
      delete process.env.XDG_CONFIG_HOME
      process.env.HOME = '/home/alice'
      process.env.SHELL = FISH
      mockStartupFiles({
        '/home/alice/.config/fish/config.fish': 'set -gx CODEX_HOME /from/process-env\n'
      })

      expect(readSessionShellStartupEnvVar('CODEX_HOME', undefined)).toBe('/from/process-env')
    })
  })
})
