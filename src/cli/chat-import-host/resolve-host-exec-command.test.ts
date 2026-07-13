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

  it('resolves a packaged macOS Electron binary the same way — no packaging branch', () => {
    // The packaged launcher execs Contents/MacOS/Orca (the Electron binary),
    // not something named "orca" — this must never be treated as a
    // direct-exec case, which used to launch the GUI instead of the host.
    const execPath = '/Applications/Orca.app/Contents/MacOS/Orca'
    const argv1 = '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/index.js'
    const result = resolveHostExecCommand(execPath, argv1)
    expect(result).toEqual({ command: execPath, args: [resolve(argv1)] })
  })

  it('resolves a packaged linux Electron binary named orca-ide the same way', () => {
    const execPath = '/opt/Orca/orca-ide'
    const argv1 = '/opt/Orca/resources/app.asar.unpacked/out/cli/index.js'
    const result = resolveHostExecCommand(execPath, argv1)
    expect(result).toEqual({ command: execPath, args: [resolve(argv1)] })
  })

  it('treats a plain "orca" binary name the same as any other execPath', () => {
    const result = resolveHostExecCommand('/usr/local/bin/orca', 'out/cli/index.js')
    expect(result).toEqual({
      command: '/usr/local/bin/orca',
      args: [resolve('out/cli/index.js')]
    })
  })

  it('resolves a Windows dev (node.exe) process to node + the CLI entry script', () => {
    const result = resolveHostExecCommand('C:\\node\\node.exe', 'out\\cli\\index.js')
    expect(result).toEqual({
      command: 'C:\\node\\node.exe',
      args: [resolve('out\\cli\\index.js')]
    })
  })

  it('resolves a Windows packaged orca.exe the same way — no packaging branch', () => {
    const result = resolveHostExecCommand('C:\\Programs\\Orca\\orca.exe', 'out\\cli\\index.js')
    expect(result).toEqual({
      command: 'C:\\Programs\\Orca\\orca.exe',
      args: [resolve('out\\cli\\index.js')]
    })
  })
})
