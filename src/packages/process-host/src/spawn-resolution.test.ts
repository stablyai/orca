import { describe, expect, it } from 'vitest'
import { resolveSpawn } from './spawn-resolution'

const CMD_SHIM = 'C:\\tools\\tool.cmd'

function commandFile(env: NodeJS.ProcessEnv): string {
  return resolveSpawn({ program: CMD_SHIM, env }, 'win32').file
}

describe('resolveSpawn ComSpec on Windows', () => {
  it('uses COMSPEC whatever the key case', () => {
    expect(commandFile({ COMSPEC: 'D:\\Shell\\cmd.exe' })).toBe('D:\\Shell\\cmd.exe')
    expect(commandFile({ comspec: 'E:\\Shell\\cmd.exe' })).toBe('E:\\Shell\\cmd.exe')
  })

  it('ignores a blank ComSpec and resolves the System32 fallback through SYSTEMROOT', () => {
    expect(commandFile({ COMSPEC: '   ', SYSTEMROOT: 'F:\\Win' })).toBe(
      'F:\\Win\\System32\\cmd.exe'
    )
  })

  it('resolves the fallback through windir when ComSpec is absent from the supplied env', () => {
    expect(commandFile({ windir: 'G:\\Other' })).toBe('G:\\Other\\System32\\cmd.exe')
  })

  it('keeps the last-resort System32 path when no root is supplied', () => {
    expect(commandFile({})).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})
