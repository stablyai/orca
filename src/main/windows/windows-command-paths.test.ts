import { describe, expect, it } from 'vitest'
import { getSystem32ExePath } from './windows-command-paths'

describe('getSystem32ExePath', () => {
  it.each([
    [{ SystemRoot: 'D:\\Win', windir: 'E:\\Win' }, 'D:\\Win\\System32\\cmd.exe'],
    [{ SystemRoot: '   ', windir: 'D:\\Win' }, 'D:\\Win\\System32\\cmd.exe'],
    [{ SystemRoot: 'Windows', windir: '' }, 'C:\\Windows\\System32\\cmd.exe'],
    [{}, 'C:\\Windows\\System32\\cmd.exe']
  ])('resolves %o to %s', (env, expected) => {
    expect(getSystem32ExePath('cmd.exe', env)).toBe(expected)
  })
})
