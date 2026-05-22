import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getSpawnArgsForWindows,
  isPermissionError,
  isWindowsBatchScript,
  resolveWindowsCommand
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
      expect(() => getSpawnArgsForWindows('C:\\tools\\agent.cmd', ['hello & goodbye'])).toThrow(
        'UNSAFE_WINDOWS_BATCH_ARGUMENTS'
      )
    })
  })

  it('rejects unsafe command paths for .cmd scripts on win32', () => {
    withPlatform('win32', () => {
      expect(() => getSpawnArgsForWindows('C:\\bad&path\\agent.cmd', ['login'])).toThrow(
        'UNSAFE_WINDOWS_BATCH_ARGUMENTS'
      )
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
