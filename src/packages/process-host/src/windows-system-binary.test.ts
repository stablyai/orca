import { describe, expect, it } from 'vitest'
import { windowsPowerShellPath, windowsSystem32Binary } from './windows-system-binary'

describe('windowsSystem32Binary', () => {
  it('reads a mixed-case SYSTEMROOT and skips a blank SystemRoot', () => {
    expect(windowsSystem32Binary('cmd.exe', { SystemRoot: '   ', SYSTEMROOT: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\cmd.exe'
    )
  })

  it('reads mixed-case WINDIR when SystemRoot is absent', () => {
    expect(windowsSystem32Binary('cmd.exe', { WINDIR: 'E:\\Other' })).toBe(
      'E:\\Other\\System32\\cmd.exe'
    )
  })

  it('keeps C:\\Windows only when every root is blank or absent', () => {
    expect(windowsSystem32Binary('cmd.exe', { SystemRoot: '', WINDIR: '  ' })).toBe(
      'C:\\Windows\\System32\\cmd.exe'
    )
  })
})

describe('windowsPowerShellPath', () => {
  it('reads a mixed-case SystemRoot', () => {
    expect(windowsPowerShellPath({ SYSTEMROOT: 'F:\\Sys' })).toBe(
      'F:\\Sys\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
  })
})
