import { describe, expect, it } from 'vitest'
import {
  buildWindowsLaunchInvocation,
  expandWindowsEnvironmentVariables,
  extractWindowsExecutablePath,
  fallbackWindowsApplicationName
} from './windows-open-with-applications'

describe('extractWindowsExecutablePath', () => {
  it('reads a quoted executable path', () => {
    expect(
      extractWindowsExecutablePath('"C:\\Program Files\\App\\app.exe" "%1"', () => false)
    ).toBe('C:\\Program Files\\App\\app.exe')
  })

  it('probes unquoted spaced paths against the filesystem', () => {
    const existing = new Set(['C:\\Program Files\\My App\\app.exe'])
    expect(
      extractWindowsExecutablePath('C:\\Program Files\\My App\\app.exe %1', (path) =>
        existing.has(path)
      )
    ).toBe('C:\\Program Files\\My App\\app.exe')
  })

  it('falls back to the first token when nothing on disk matches', () => {
    expect(extractWindowsExecutablePath('C:\\App\\app.exe --flag', () => false)).toBe(
      'C:\\App\\app.exe'
    )
  })

  it('rejects commands without a closing quote', () => {
    expect(extractWindowsExecutablePath('"C:\\App\\app.exe', () => true)).toBeNull()
  })
})

describe('buildWindowsLaunchInvocation', () => {
  it('substitutes %1 placeholders with the file path', () => {
    expect(
      buildWindowsLaunchInvocation('"C:\\App\\app.exe" "%1"', 'D:\\notes\\todo.md', () => false)
    ).toEqual({ spawnCmd: 'C:\\App\\app.exe', spawnArgs: ['D:\\notes\\todo.md'] })
  })

  it('keeps flags and drops unfillable %2+/%* placeholders', () => {
    expect(
      buildWindowsLaunchInvocation(
        '"C:\\App\\app.exe" --reuse-window "%1" %*',
        'D:\\a.txt',
        () => false
      )
    ).toEqual({ spawnCmd: 'C:\\App\\app.exe', spawnArgs: ['--reuse-window', 'D:\\a.txt'] })
  })

  it('substitutes placeholders embedded inside a token', () => {
    expect(
      buildWindowsLaunchInvocation('"C:\\App\\app.exe" --file=%1', 'D:\\a.txt', () => false)
    ).toEqual({ spawnCmd: 'C:\\App\\app.exe', spawnArgs: ['--file=D:\\a.txt'] })
  })

  it('appends the file path when the command has no placeholder', () => {
    expect(buildWindowsLaunchInvocation('"C:\\App\\app.exe"', 'D:\\a.txt', () => false)).toEqual({
      spawnCmd: 'C:\\App\\app.exe',
      spawnArgs: ['D:\\a.txt']
    })
  })

  it('fills Office-style %u placeholders with the file path', () => {
    expect(
      buildWindowsLaunchInvocation(
        '"C:\\Office\\POWERPNT.EXE" "%1" /ou "%u"',
        'D:\\paper survey\\deck.pptx',
        () => false
      )
    ).toEqual({
      spawnCmd: 'C:\\Office\\POWERPNT.EXE',
      spawnArgs: ['D:\\paper survey\\deck.pptx', '/ou', 'D:\\paper survey\\deck.pptx']
    })
  })

  it('leaves unexpanded environment-style tokens alone', () => {
    expect(
      buildWindowsLaunchInvocation(
        '"C:\\App\\app.exe" %USERPROFILE% "%1"',
        'D:\\a.txt',
        () => false
      )
    ).toEqual({
      spawnCmd: 'C:\\App\\app.exe',
      spawnArgs: ['%USERPROFILE%', 'D:\\a.txt']
    })
  })
})

describe('expandWindowsEnvironmentVariables', () => {
  it('expands known variables and preserves launch placeholders', () => {
    expect(
      expandWindowsEnvironmentVariables('%SystemRoot%\\notepad.exe %1', {
        SystemRoot: 'C:\\Windows'
      } as NodeJS.ProcessEnv)
    ).toBe('C:\\Windows\\notepad.exe %1')
  })
})

describe('fallbackWindowsApplicationName', () => {
  it('prettifies the executable base name', () => {
    expect(fallbackWindowsApplicationName('C:\\Windows\\notepad.exe')).toBe('Notepad')
  })
})
