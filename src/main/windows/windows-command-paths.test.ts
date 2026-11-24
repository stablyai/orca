import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getSystem32ExePath, resolveWindowsCommand } from './windows-command-paths'

describe('getSystem32ExePath', () => {
  it('reads SystemRoot and windir regardless of key case', () => {
    expect(getSystem32ExePath('reg.exe', { SYSTEMROOT: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\reg.exe'
    )
    expect(getSystem32ExePath('reg.exe', { windir: 'E:\\Windows' })).toBe(
      'E:\\Windows\\System32\\reg.exe'
    )
  })

  it('prefers SystemRoot over windir regardless of key order', () => {
    expect(getSystem32ExePath('reg.exe', { windir: 'E:\\Windows', SystemRoot: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\reg.exe'
    )
    expect(getSystem32ExePath('reg.exe', { SystemRoot: '   ', windir: 'E:\\Windows' })).toBe(
      'E:\\Windows\\System32\\reg.exe'
    )
  })

  it('falls back when the value is blank', () => {
    expect(getSystem32ExePath('reg.exe', { SystemRoot: '   ' })).toBe(
      'C:\\Windows\\System32\\reg.exe'
    )
  })
})

/** PATH search needs native Windows separators; the key/value parsing above runs everywhere. */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('resolveWindowsCommand', () => {
  const dirs: string[] = []
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-command-paths-'))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a lowercased PATH key', () => {
    const dir = tempDir()
    const shim = join(dir, 'tool.cmd')
    writeFileSync(shim, '')
    expect(resolveWindowsCommand('tool', { path: dir })).toBe(shim)
  })

  it('finds a command in a quoted PATH entry', () => {
    const dir = tempDir()
    const shim = join(dir, 'tool.cmd')
    writeFileSync(shim, '')
    expect(resolveWindowsCommand('tool', { Path: `"${dir}"` })).toBe(shim)
  })

  it('skips a directory shadowing the command earlier in PATH', () => {
    const shadow = tempDir()
    const real = tempDir()
    mkdirSync(join(shadow, 'tool.cmd'))
    const shim = join(real, 'tool.cmd')
    writeFileSync(shim, '')
    expect(resolveWindowsCommand('tool', { PATH: [shadow, real].join(delimiter) })).toBe(shim)
  })

  it('resolves a bare command with an explicit .cmd extension', () => {
    const dir = tempDir()
    const shim = join(dir, 'git.cmd')
    writeFileSync(shim, '')
    expect(resolveWindowsCommand('git.cmd', { PATH: dir })).toBe(shim)
  })

  it('does not append suffixes to an explicitly extended command', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'git.exe.cmd'), '')
    const shim = join(dir, 'git.exe')
    writeFileSync(shim, '')
    expect(resolveWindowsCommand('git.exe', { PATH: dir })).toBe(shim)
  })

  it('selects the PATH key that Node passes to the child', () => {
    const stale = tempDir()
    const active = tempDir()
    writeFileSync(join(stale, 'tool.cmd'), '')
    const shim = join(active, 'tool.cmd')
    writeFileSync(shim, '')
    expect(resolveWindowsCommand('tool', { Path: stale, PATH: active })).toBe(shim)
  })

  it('does not fall through when the selected PATH key is blank', () => {
    const stale = tempDir()
    writeFileSync(join(stale, 'tool.cmd'), '')
    expect(resolveWindowsCommand('tool', { PATH: '', Path: stale })).toBe('tool')
  })

  it('ignores a malformed PATH entry without throwing', () => {
    const dir = tempDir()
    const shim = join(dir, 'tool.cmd')
    writeFileSync(shim, '')
    expect(resolveWindowsCommand('tool', { PATH: [`bad\u0000segment`, dir].join(delimiter) })).toBe(
      shim
    )
  })
})
