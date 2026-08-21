import { describe, expect, it } from 'vitest'
import {
  appendMCodeRpcOutput,
  resolveMCodeCliCommand,
  resolveMCodeCliInvocation
} from './live-remote-freeze-rpc.mjs'

describe('live remote freeze RPC', () => {
  it('resolves the MCode CLI for managed, dev, Linux, and default runtimes', () => {
    expect(resolveMCodeCliCommand({ env: { MCODE_CLI_COMMAND: 'custom-mcode' } })).toBe('custom-mcode')
    expect(resolveMCodeCliCommand({ env: { MCODE_DEV_REPO_ROOT: '/repo' } })).toBe('mcode-dev')
    expect(resolveMCodeCliCommand({ env: {}, platform: 'linux' })).toBe('mcode-ide')
    expect(resolveMCodeCliCommand({ env: {}, platform: 'win32' })).toBe('mcode')
  })

  it('bypasses the Windows dev cmd shim with the built Node CLI', () => {
    const invocation = resolveMCodeCliInvocation({
      env: {
        APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
        MCODE_CLI_COMMAND: 'C:\\repo\\out\\bin\\mcode-dev.cmd',
        MCODE_DEV_REPO_ROOT: 'C:\\repo'
      },
      platform: 'win32',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe'
    })

    expect(invocation).toMatchObject({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      prefixArgs: ['C:\\repo\\out\\cli\\index.js'],
      env: {
        MCODE_USER_DATA_PATH: 'C:\\Users\\dev\\AppData\\Roaming\\mcode-dev',
        MCODE_DEV_CLI_INVOCATION: '1',
        MCODE_APP_EXECUTABLE: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
        MCODE_APP_EXECUTABLE_NEEDS_APP_ROOT: '1'
      }
    })
  })

  it('caps combined asynchronous output before retaining the overflow chunk', () => {
    const first = appendMCodeRpcOutput('', '1234', 0, 5)
    expect(first).toEqual({ output: '1234', bytes: 4, exceeded: false })

    const overflow = appendMCodeRpcOutput(first.output, '67', first.bytes, 5)
    expect(overflow).toEqual({ output: '1234', bytes: 6, exceeded: true })
  })
})
