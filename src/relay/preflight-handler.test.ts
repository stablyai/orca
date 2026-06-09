import { describe, expect, it } from 'vitest'
import { buildCommandLookupSpec, hasAbsoluteCommandPath } from './preflight-handler'

describe('buildCommandLookupSpec', () => {
  it('uses where.exe on native Windows SSH hosts', () => {
    expect(buildCommandLookupSpec('codex', 'win32')).toEqual({
      file: 'where.exe',
      args: ['codex'],
      windowsHide: true
    })
  })

  it('passes the command as an argument to the POSIX login-shell probe', () => {
    expect(buildCommandLookupSpec('codex', 'linux')).toEqual({
      file: '/bin/sh',
      args: ['-lc', 'command -v "$1"', 'sh', 'codex']
    })
  })
})

describe('hasAbsoluteCommandPath', () => {
  it('recognizes Windows absolute command paths', () => {
    expect(
      hasAbsoluteCommandPath('C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd\r\n', 'win32')
    ).toBe(true)
  })
})
