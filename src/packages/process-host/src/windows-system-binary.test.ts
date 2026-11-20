// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { windowsPowerShellPath, windowsSystem32Binary, windowsSystemRoot } from './windows-system-binary'

// Windows spells the install root three ways: process.env on Windows, SYSTEMROOT in MSYS/Git Bash
// and cloned plain objects, and windir on older shells. Missing the lowercase spellings silently
// falls back to C:\Windows on a machine installed elsewhere (#pending).
describe('windowsSystemRoot', () => {
  it('prefers SystemRoot, then SYSTEMROOT, then windir', () => {
    expect(windowsSystemRoot({ SystemRoot: 'D:\\Windows', SYSTEMROOT: 'E:\\W', windir: 'F:\\W' })).toBe(
      'D:\\Windows'
    )
    expect(windowsSystemRoot({ SYSTEMROOT: 'E:\\W', windir: 'F:\\W' })).toBe('E:\\W')
    expect(windowsSystemRoot({ windir: 'F:\\W' })).toBe('F:\\W')
  })

  it('falls back to C:\\Windows only when no spelling is present', () => {
    expect(windowsSystemRoot({})).toBe('C:\\Windows')
  })
})

describe('absolute system paths use the resolved root', () => {
  it('builds the System32 binary and PowerShell paths from SYSTEMROOT alone', () => {
    expect(windowsSystem32Binary('taskkill.exe', { SYSTEMROOT: 'D:\\Windows' })).toBe(
      'D:\\Windows\\System32\\taskkill.exe'
    )
    expect(windowsPowerShellPath({ windir: 'E:\\W' })).toBe(
      'E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
  })
})
