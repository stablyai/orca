import { describe, expect, it } from 'vitest'
import { resolvePnpmCliSpawn } from './pnpm-cli-spawn.mjs'

describe('resolvePnpmCliSpawn', () => {
  it('uses the executable directly on POSIX', () => {
    expect(resolvePnpmCliSpawn(['run', 'typecheck'], { platform: 'linux' })).toEqual({
      command: 'pnpm',
      args: ['run', 'typecheck']
    })
  })

  it('preserves whitespace arguments without a Windows command shell', () => {
    expect(
      resolvePnpmCliSpawn(['exec', 'playwright', '--grep', 'legacy SSH fork'], {
        platform: 'win32',
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        npmExecPath: 'C:\\pnpm\\pnpm.cjs'
      })
    ).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\pnpm\\pnpm.cjs', 'exec', 'playwright', '--grep', 'legacy SSH fork']
    })
  })

  it('requires pnpm package-script context on Windows', () => {
    expect(() =>
      resolvePnpmCliSpawn([], {
        platform: 'win32',
        nodePath: 'node.exe',
        npmExecPath: undefined
      })
    ).toThrow('Run this command through pnpm')
  })
})
