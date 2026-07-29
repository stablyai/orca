import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getCmdExePath,
  getRegExePath,
  getSpawnArgsForWindows,
  isPermissionError,
  isWindowsBatchScript,
  resolveWindowsCommand,
  WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL,
  UnsafeWindowsBatchArgumentsError
} from './win32-utils'

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('isWindowsBatchScript', () => {
  it('detects .cmd and .bat on win32', () => {
    withPlatform('win32', () => {
      expect(isWindowsBatchScript('C:\\tools\\codex.cmd')).toBe(true)
      expect(isWindowsBatchScript('C:\\tools\\codex.BAT')).toBe(true)
    })
  })

  it('returns false for non-batch extensions', () => {
    withPlatform('win32', () => {
      expect(isWindowsBatchScript('C:\\tools\\codex.exe')).toBe(false)
      expect(isWindowsBatchScript('C:\\tools\\codex')).toBe(false)
    })
  })

  it('returns false on non-win32 regardless of extension', () => {
    withPlatform('linux', () => {
      expect(isWindowsBatchScript('/usr/bin/foo.cmd')).toBe(false)
    })
  })
})

describe('getRegExePath', () => {
  it('falls back to a local absolute system path for unsafe roots', () => {
    expect(getRegExePath({ SystemRoot: '' })).toBe('C:\\Windows\\System32\\reg.exe')
    expect(getRegExePath({ SystemRoot: 'Windows' })).toBe('C:\\Windows\\System32\\reg.exe')
    expect(getRegExePath({ SystemRoot: '\\\\server\\share' })).toBe(
      'C:\\Windows\\System32\\reg.exe'
    )
  })

  it('uses an absolute custom Windows root', () => {
    expect(getRegExePath({ SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\reg.exe')
  })
})

describe('getSpawnArgsForWindows', () => {
  it('routes .cmd through cmd.exe with /d /c on win32', () => {
    const originalComSpec = process.env.ComSpec
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    try {
      withPlatform('win32', () => {
        const { spawnCmd, spawnArgs } = getSpawnArgsForWindows('C:\\tools\\codex.cmd', [
          'login',
          '--foo'
        ])
        expect(spawnCmd).toBe('C:\\Windows\\System32\\cmd.exe')
        // Why: /d disables AutoRun; /c runs the batch command and exits.
        // Separate argv entries avoid cmd.exe seeing Node-escaped quotes.
        expect(spawnArgs).toEqual(['/d', '/c', 'C:\\tools\\codex.cmd', 'login', '--foo'])
      })
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec
      } else {
        process.env.ComSpec = originalComSpec
      }
    }
  })

  it('preserves VS Code WSL remote arguments with spaces through .cmd launchers', () => {
    withPlatform('win32', () => {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows('C:\\tools\\code.cmd', [
        '--remote',
        'wsl+Ubuntu Preview',
        '/home/Ada Lovelace/project'
      ])

      expect(spawnCmd).toBe(getCmdExePath())
      expect(spawnArgs).toEqual([
        '/d',
        '/c',
        'C:\\tools\\code.cmd',
        '--remote',
        'wsl+Ubuntu Preview',
        '/home/Ada Lovelace/project'
      ])
    })
  })

  it('passes .exe through unchanged on win32', () => {
    withPlatform('win32', () => {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows('C:\\tools\\codex.exe', ['login'])
      expect(spawnCmd).toBe('C:\\tools\\codex.exe')
      expect(spawnArgs).toEqual(['login'])
    })
  })

  it('passes posix paths through unchanged on non-win32', () => {
    withPlatform('darwin', () => {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows('/usr/local/bin/codex', ['login'])
      expect(spawnCmd).toBe('/usr/local/bin/codex')
      expect(spawnArgs).toEqual(['login'])
    })
  })

  it('rejects unsafe args for .cmd scripts on win32', () => {
    withPlatform('win32', () => {
      for (const argument of ['hello & goodbye', 'a | b', 'x > y', '%PATH%', 'a\nb']) {
        expect(() => getSpawnArgsForWindows('C:\\tools\\agent.cmd', [argument])).toThrow(
          'UNSAFE_WINDOWS_BATCH_ARGUMENTS'
        )
      }
    })
  })

  it('rejects unsafe command paths for .cmd scripts on win32', () => {
    withPlatform('win32', () => {
      expect(() => getSpawnArgsForWindows('C:\\bad&path\\agent.cmd', ['login'])).toThrow(
        'UNSAFE_WINDOWS_BATCH_ARGUMENTS'
      )
    })
  })

  it('allows punctuation that is not a cmd command operator', () => {
    withPlatform('win32', () => {
      expect(
        getSpawnArgsForWindows('C:\\tools\\agent.cmd', ['package,name;version']).spawnArgs
      ).toEqual(['/d', '/c', 'C:\\tools\\agent.cmd', 'package,name;version'])
    })
  })

  // Why: parentheses only group commands and cannot chain one without a separator
  // the guard already rejects, so paren-bearing paths must stay spawnable.
  it('spawns .cmd shims under Program Files (x86) and paren-bearing worktrees', () => {
    withPlatform('win32', () => {
      const npx = 'C:\\Program Files (x86)\\nodejs\\npx.cmd'
      expect(getSpawnArgsForWindows(npx, ['C:\\dev\\app (fork)'])).toEqual({
        spawnCmd: getCmdExePath(),
        spawnArgs: ['/d', '/c', npx, 'C:\\dev\\app (fork)']
      })
      expect(getSpawnArgsForWindows('C:\\tools\\agent.cmd', ['close)', '(open']).spawnArgs).toEqual(
        ['/d', '/c', 'C:\\tools\\agent.cmd', 'close)', '(open']
      )
    })
  })

  it('still rejects a paren-wrapped command chain', () => {
    withPlatform('win32', () => {
      expect(() => getSpawnArgsForWindows('C:\\tools\\agent.cmd', ['(x & calc.exe)'])).toThrow(
        'UNSAFE_WINDOWS_BATCH_ARGUMENTS'
      )
    })
  })

  it('rejects exactly the characters the message advertises', () => {
    withPlatform('win32', () => {
      const advertised = WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL.split(' ')
      expect(advertised.length).toBeGreaterThan(0)
      for (const character of advertised) {
        expect(() => getSpawnArgsForWindows('C:\\tools\\agent.cmd', [`a${character}b`])).toThrow(
          'UNSAFE_WINDOWS_BATCH_ARGUMENTS'
        )
      }
      // Why: anything not advertised must pass, or the message misleads the user.
      for (const character of ['(', ')', ',', ';', '@', '#', '$', "'", '~', '=']) {
        expect(advertised).not.toContain(character)
        expect(() =>
          getSpawnArgsForWindows('C:\\tools\\agent.cmd', [`a${character}b`])
        ).not.toThrow()
      }
    })
  })

  // Why: Source Control AI delivers its prompt in argv (`promptDelivery: 'argv'`),
  // and those prompts are multiline by construction. Both standard Windows Cursor
  // entry points resolve to batch shims, so this rejection is reached before
  // cmd.exe ever runs. Locking it here documents that the alias added for
  // alias-only installs does not change the outcome: the batch-shim limitation
  // is upstream of command naming and needs a separate launch strategy.
  it('rejects multiline argv prompts for either Cursor batch shim on win32', () => {
    const multilinePrompt = [
      'Write a commit message for this diff:',
      '',
      '+ const value = 1',
      '- const value = 0'
    ].join('\n')

    withPlatform('win32', () => {
      for (const shim of ['C:\\cursor-agent\\cursor-agent.cmd', 'C:\\cursor\\cursor.cmd']) {
        expect(() => getSpawnArgsForWindows(shim, ['--print', multilinePrompt])).toThrow(
          UnsafeWindowsBatchArgumentsError
        )
      }

      // The `cursor` alias launches through a subcommand, so the prompt sits
      // further along argv. The rejection must still fire.
      expect(() =>
        getSpawnArgsForWindows('C:\\cursor\\cursor.cmd', ['agent', '--print', multilinePrompt])
      ).toThrow(UnsafeWindowsBatchArgumentsError)
    })
  })

  // Why: a .ps1 launcher is not a batch script, so the multiline prompt survives.
  // This is the shape of the only override reported to work end-to-end on Windows.
  it('passes multiline argv prompts through a non-batch launcher on win32', () => {
    withPlatform('win32', () => {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-File', 'C:\\cursor-agent\\cursor-agent.ps1', '--print', 'line one\nline two']
      )

      expect(spawnCmd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      expect(spawnArgs).toEqual([
        '-File',
        'C:\\cursor-agent\\cursor-agent.ps1',
        '--print',
        'line one\nline two'
      ])
    })
  })
})

describe('resolveWindowsCommand', () => {
  it('finds package-manager .cmd shims on PATH before spawning fixed commands', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-win-command-'))
    try {
      const pnpmShim = join(tempDir, 'pnpm.cmd')
      writeFileSync(pnpmShim, '@echo off\r\n')

      withPlatform('win32', () => {
        expect(resolveWindowsCommand('pnpm', { PATH: tempDir })).toBe(pnpmShim)
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('leaves explicit command paths unchanged', () => {
    withPlatform('win32', () => {
      expect(resolveWindowsCommand('C:\\tools\\npm.cmd', { PATH: 'C:\\other' })).toBe(
        'C:\\tools\\npm.cmd'
      )
    })
  })
})

describe('isPermissionError', () => {
  it('returns true for EPERM and EACCES Node errors', () => {
    const eperm = Object.assign(new Error('denied'), { code: 'EPERM' })
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' })
    expect(isPermissionError(eperm)).toBe(true)
    expect(isPermissionError(eacces)).toBe(true)
  })

  it('returns false for unrelated errors and non-error values', () => {
    expect(isPermissionError(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe(false)
    expect(isPermissionError(new Error('plain'))).toBe(false)
    expect(isPermissionError(null)).toBe(false)
    expect(isPermissionError('EPERM')).toBe(false)
  })
})
