import { expect, it } from 'vitest'
import { windowsPowerShellPath, windowsSystem32Binary } from './windows-system-binary'

it('ignores blank SystemRoot values and falls back through SYSTEMROOT, windir, WINDIR, and C:\\Windows', () => {
  expect(windowsSystem32Binary('cmd.exe', { SystemRoot: '', SYSTEMROOT: '   ' })).toBe(
    'C:\\Windows\\System32\\cmd.exe'
  )
  expect(windowsSystem32Binary('reg.exe', { SystemRoot: '   ', WINDIR: ' D:\\Windows ' })).toBe(
    'D:\\Windows\\System32\\reg.exe'
  )
  expect(windowsPowerShellPath({ SystemRoot: '', windir: 'E:\\Win' })).toBe(
    'E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  )
})
