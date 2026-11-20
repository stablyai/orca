import { describe, expect, it } from 'vitest'
import { windowsPowerShellPath, windowsSystem32Binary } from './windows-system-binary'

describe('windows system binary resolution', () => {
  it('joins System32 with Windows separators from a trimmed SystemRoot', () => {
    expect(windowsSystem32Binary('tar.exe', { SystemRoot: ' D:\\Win ' })).toBe(
      'D:\\Win\\System32\\tar.exe'
    )
  })

  it('falls through blank values to the later env names', () => {
    expect(windowsSystem32Binary('wsl.exe', { SystemRoot: '  ', windir: 'E:\\Win' })).toBe(
      'E:\\Win\\System32\\wsl.exe'
    )
    expect(
      windowsSystem32Binary('ssh.exe', {
        SystemRoot: ' ',
        SYSTEMROOT: ' ',
        windir: ' ',
        WINDIR: 'F:\\Win'
      })
    ).toBe('F:\\Win\\System32\\ssh.exe')
  })

  it('defaults to C:\\Windows when every name is blank or absent', () => {
    expect(windowsSystem32Binary('tar.exe', { SystemRoot: ' ' })).toBe(
      'C:\\Windows\\System32\\tar.exe'
    )
    expect(windowsPowerShellPath({})).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
  })
})
