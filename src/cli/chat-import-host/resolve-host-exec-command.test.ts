import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveHostExecCommand } from './resolve-host-exec-command'

describe('resolveHostExecCommand', () => {
  it('resolves a dev (node) process to node + the CLI entry script', () => {
    const result = resolveHostExecCommand('/usr/local/bin/node', 'out/cli/index.js')
    expect(result).toEqual({
      command: '/usr/local/bin/node',
      args: [resolve('out/cli/index.js')]
    })
  })

  it('resolves a packaged orca binary to a direct exec with no args', () => {
    const result = resolveHostExecCommand('/usr/local/bin/orca', '/usr/local/bin/orca')
    expect(result).toEqual({ command: '/usr/local/bin/orca', args: [] })
  })

  it('treats orca-dev as a packaged binary too', () => {
    const result = resolveHostExecCommand('/opt/orca/orca-dev', '/opt/orca/orca-dev')
    expect(result).toEqual({ command: '/opt/orca/orca-dev', args: [] })
  })

  it('is case-insensitive and strips .exe on Windows packaged binaries', () => {
    const result = resolveHostExecCommand('C:\\Programs\\Orca\\orca.exe', 'ignored')
    expect(result).toEqual({ command: 'C:\\Programs\\Orca\\orca.exe', args: [] })
  })

  it('resolves a Windows dev (node.exe) process to node + the CLI entry script', () => {
    const result = resolveHostExecCommand('C:\\node\\node.exe', 'out\\cli\\index.js')
    expect(result).toEqual({
      command: 'C:\\node\\node.exe',
      args: [resolve('out\\cli\\index.js')]
    })
  })
})
