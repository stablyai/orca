import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getRegExePath, resolveWindowsCommand } from './windows-command-paths'

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

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
