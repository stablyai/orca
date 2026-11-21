import { afterEach, expect, it, vi } from 'vitest'
import { buildWindowsCommandInvocation } from './windows-command-invocation'

afterEach(() => {
  vi.unstubAllEnvs()
})

it('falls back to System32 cmd.exe when ComSpec is unset or blank', () => {
  vi.stubEnv('SystemRoot', 'D:\\Windows')
  vi.stubEnv('ComSpec', '')
  vi.stubEnv('COMSPEC', '')

  expect(buildWindowsCommandInvocation('claude', ['auth', 'login']).command).toBe(
    'D:\\Windows\\System32\\cmd.exe'
  )

  vi.stubEnv('ComSpec', '   ')
  vi.stubEnv('COMSPEC', '   ')

  expect(buildWindowsCommandInvocation('claude', ['auth', 'login']).command).toBe(
    'D:\\Windows\\System32\\cmd.exe'
  )
})

it('uses ComSpec when set', () => {
  vi.stubEnv('ComSpec', 'E:\\Custom\\cmd.exe')

  expect(buildWindowsCommandInvocation('claude', ['auth']).command).toBe('E:\\Custom\\cmd.exe')
})
