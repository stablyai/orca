import { expect, it } from 'vitest'
import {
  resolveWindowsComSpec,
  windowsPowerShellPath,
  windowsSystem32Binary
} from './windows-system-binary'

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

// A cloned or MSYS-derived env can carry any casing; an exact-key read would miss these.
it('reads the install root in any casing', () => {
  expect(windowsSystem32Binary('taskkill.exe', { systemroot: 'D:\\Windows' })).toBe(
    'D:\\Windows\\System32\\taskkill.exe'
  )
  expect(windowsSystem32Binary('taskkill.exe', { SYSTEMROOT: '  E:\\Win  ' })).toBe(
    'E:\\Win\\System32\\taskkill.exe'
  )
  expect(windowsPowerShellPath({ WINDIR: 'F:\\W' })).toBe(
    'F:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  )
})

it('prefers SystemRoot over windir and never returns a relative System32 path', () => {
  expect(windowsSystem32Binary('reg.exe', { windir: 'E:\\W', SystemRoot: 'D:\\Windows' })).toBe(
    'D:\\Windows\\System32\\reg.exe'
  )
  expect(windowsSystem32Binary('reg.exe', {})).toBe('C:\\Windows\\System32\\reg.exe')
})

it('resolves ComSpec in any casing, then builds cmd.exe from the install root', () => {
  expect(resolveWindowsComSpec({ comspec: ' D:\\Tools\\cmd.exe ' })).toBe('D:\\Tools\\cmd.exe')
  expect(resolveWindowsComSpec({ COMSPEC: '' }, { systemroot: 'E:\\Win' })).toBe(
    'E:\\Win\\System32\\cmd.exe'
  )
  // An explicit env's blank ComSpec must fall back to that same env's root, not this process's.
  expect(resolveWindowsComSpec({ COMSPEC: '  ', WINDIR: 'F:\\W' }, {})).toBe(
    'F:\\W\\System32\\cmd.exe'
  )
})
