import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock
}))

import { __resetShellStartupEnvCache, readShellStartupEnvVar } from './shell-startup-env'

describe('readShellStartupEnvVar', () => {
  const originalPlatform = process.platform
  const originalShell = process.env.SHELL

  beforeEach(() => {
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
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
  })

  function mockStartupFiles(files: Record<string, string>) {
    existsSyncMock.mockImplementation((p: string) => {
      const file = p.split('/').pop() ?? ''
      return file in files
    })
    readFileSyncMock.mockImplementation((p: string) => {
      const file = p.split('/').pop() ?? ''
      if (file in files) {
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
    expect(readShellStartupEnvVar('OPENCODE_CONFIG_DIR', '/home/alice')).toBeUndefined()
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
})
