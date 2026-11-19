import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRegExePath, getSystem32ExePath, resolveWindowsCommand } from './windows-command-paths'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-win-cmd-paths-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('getSystem32ExePath', () => {
  it('reads SystemRoot case-insensitively on plain env objects', () => {
    expect(getSystem32ExePath('icacls.exe', { SystemRoot: 'D:\\Windows' })).toBe(
      'D:\\Windows\\System32\\icacls.exe'
    )
    expect(getSystem32ExePath('icacls.exe', { SYSTEMROOT: 'E:\\Windows' })).toBe(
      'E:\\Windows\\System32\\icacls.exe'
    )
    expect(getRegExePath({ systemroot: 'F:/Windows' })).toBe('F:\\Windows\\System32\\reg.exe')
  })

  it('falls back to C:\\Windows when SystemRoot is missing or not a drive path', () => {
    expect(getSystem32ExePath('icacls.exe', {})).toBe('C:\\Windows\\System32\\icacls.exe')
    expect(getSystem32ExePath('icacls.exe', { SYSTEMROOT: 'relative\\Windows' })).toBe(
      'C:\\Windows\\System32\\icacls.exe'
    )
  })
})

describe('resolveWindowsCommand', () => {
  it.skipIf(process.platform !== 'win32')(
    'skips matching directories, strips quoted PATH segments, reads lowercase path, and resolves explicit .cmd/.exe names',
    () => {
      const collidingDir = join(root, 'colliding')
      const quotedDir = join(root, 'dir with spaces')
      mkdirSync(join(collidingDir, 'tool'), { recursive: true })
      mkdirSync(join(collidingDir, 'tool.exe'), { recursive: true })
      mkdirSync(quotedDir, { recursive: true })

      const toolCmd = join(quotedDir, 'tool.cmd')
      const toolExe = join(quotedDir, 'other.exe')
      writeFileSync(toolCmd, '@echo off\r\n')
      writeFileSync(toolExe, '')

      const env = { path: `${collidingDir};"${quotedDir}"` }
      expect(resolveWindowsCommand('tool', env)).toBe(toolCmd)
      expect(resolveWindowsCommand('tool.cmd', env)).toBe(toolCmd)
      expect(resolveWindowsCommand('other.exe', env)).toBe(toolExe)
      expect(resolveWindowsCommand('C:\\custom\\tool.exe', env)).toBe('C:\\custom\\tool.exe')
    }
  )
})
