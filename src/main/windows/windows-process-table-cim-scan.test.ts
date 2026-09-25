import { describe, expect, it } from 'vitest'
import { parseWindowsCimProcessRows } from './windows-process-table-cim-scan'

describe('parseWindowsCimProcessRows', () => {
  it('reads the array form ConvertTo-Json emits for a real table', () => {
    const stdout = JSON.stringify([
      { CommandLine: 'node relay.js', Name: 'node.exe', ParentProcessId: 4, ProcessId: 100 },
      { CommandLine: 'claude --resume', Name: 'claude.exe', ParentProcessId: 100, ProcessId: 200 }
    ])
    expect(parseWindowsCimProcessRows(stdout)).toEqual([
      { pid: 100, ppid: 4, name: 'node.exe', command: 'node relay.js' },
      { pid: 200, ppid: 100, name: 'claude.exe', command: 'claude --resume' }
    ])
  })

  it('reads the bare-object form ConvertTo-Json emits for a single row', () => {
    const stdout = JSON.stringify({
      CommandLine: 'node relay.js',
      Name: 'node.exe',
      ParentProcessId: 4,
      ProcessId: 100
    })
    expect(parseWindowsCimProcessRows(stdout)).toEqual([
      { pid: 100, ppid: 4, name: 'node.exe', command: 'node relay.js' }
    ])
  })

  it('falls back to the image name when a process denied its command line', () => {
    const stdout = JSON.stringify([
      { CommandLine: null, Name: 'lsass.exe', ParentProcessId: 4, ProcessId: 700 }
    ])
    expect(parseWindowsCimProcessRows(stdout)).toEqual([
      { pid: 700, ppid: 4, name: 'lsass.exe', command: 'lsass.exe' }
    ])
  })

  it('keeps a command line containing newlines on its own row', () => {
    // The reason this reads JSON and not PowerShell's Key=Value list form.
    const stdout = JSON.stringify([
      {
        CommandLine: 'app.exe "a\nProcessId=9\nb"',
        Name: 'app.exe',
        ParentProcessId: 4,
        ProcessId: 5
      }
    ])
    expect(parseWindowsCimProcessRows(stdout)).toEqual([
      { pid: 5, ppid: 4, name: 'app.exe', command: 'app.exe "a\nProcessId=9\nb"' }
    ])
  })

  it('drops rows with no usable pid rather than inventing one', () => {
    const stdout = JSON.stringify([
      { Name: 'ghost.exe', ParentProcessId: 4 },
      { Name: 'real.exe', ParentProcessId: 4, ProcessId: 5 }
    ])
    expect(parseWindowsCimProcessRows(stdout)).toEqual([
      { pid: 5, ppid: 4, name: 'real.exe', command: 'real.exe' }
    ])
  })

  it('returns null on unparseable output so the caller can reject it', () => {
    // A policy banner or an error on stdout must not read as an idle machine.
    expect(parseWindowsCimProcessRows('Access is denied.')).toBeNull()
  })
})
