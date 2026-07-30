import { describe, expect, it } from 'vitest'
import { resolvePnpmInvocation } from './build-native-for-platform.mjs'

describe('build:native pnpm invocation', () => {
  it('runs a JS npm_execpath through Node so the pinned pnpm version is kept', () => {
    const npmExecPath = '/repo/node_modules/pnpm/bin/pnpm.cjs'

    expect(resolvePnpmInvocation('build:computer-macos', npmExecPath, 'darwin')).toEqual({
      command: process.execPath,
      args: [npmExecPath, 'run', 'build:computer-macos'],
      shell: false
    })
  })

  it('executes a standalone @pnpm/exe npm_execpath directly instead of parsing it as JS', () => {
    const npmExecPath = '/Users/dev/.local/share/mise/installs/pnpm/10.24.0/pnpm'

    expect(resolvePnpmInvocation('build:computer-macos', npmExecPath, 'darwin')).toEqual({
      command: npmExecPath,
      args: ['run', 'build:computer-macos'],
      shell: false
    })
  })

  it('falls back to the pnpm on PATH when npm_execpath is unset', () => {
    expect(resolvePnpmInvocation('build:computer-macos', undefined, 'darwin')).toEqual({
      command: 'pnpm',
      args: ['run', 'build:computer-macos'],
      shell: false
    })
    expect(resolvePnpmInvocation('build:computer-macos', '', 'win32')).toEqual({
      command: '"pnpm.cmd"',
      args: ['run', 'build:computer-macos'],
      shell: true
    })
  })

  it('shells out for a Windows .cmd npm_execpath that Node cannot spawn directly', () => {
    const npmExecPath = 'C:\\Program Files\\nodejs\\pnpm.cmd'

    expect(resolvePnpmInvocation('build:computer-macos', npmExecPath, 'win32')).toEqual({
      command: `"${npmExecPath}"`,
      args: ['run', 'build:computer-macos'],
      shell: true
    })
  })
})
