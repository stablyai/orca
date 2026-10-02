import { afterEach, describe, expect, it, vi } from 'vitest'
import { predictSpawnOrchestrationCliCommand } from './spawn-cli-command-prediction'

// A dev build names `orca-dev` everywhere; these cases are about the host and its WSL decision.
vi.mock('./cli-command', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runtimeOrchestrationCliCommand: () => undefined
}))

const realPlatform = process.platform

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

describe('predictSpawnOrchestrationCliCommand', () => {
  afterEach(() => onPlatform(realPlatform))

  it('tells a terminal on an SSH host to run the bare bridge', () => {
    onPlatform('win32')
    expect(
      predictSpawnOrchestrationCliCommand({
        connectionId: 'ssh-1',
        cwd: 'C:\\repo',
        projectRuntime: undefined,
        settings: { terminalWindowsShell: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
      })
    ).toBe('orca')
  })

  // Why: the spawn turns a Windows-path repo into a WSL session when the user's shell is WSL, and a
  // worker told `orca` there cannot report; the live terminal answers `orca-ide`.
  it('tells a Windows terminal whose shell is WSL to run the scoped launcher', () => {
    onPlatform('win32')
    expect(
      predictSpawnOrchestrationCliCommand({
        connectionId: null,
        cwd: 'C:\\repo',
        projectRuntime: undefined,
        settings: { terminalWindowsShell: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
      })
    ).toBe('orca-ide')
  })

  it('tells a Windows terminal in PowerShell to run orca', () => {
    onPlatform('win32')
    expect(
      predictSpawnOrchestrationCliCommand({
        connectionId: null,
        cwd: 'C:\\repo',
        projectRuntime: undefined,
        settings: { terminalWindowsShell: 'powershell.exe' }
      })
    ).toBe('orca')
  })

  it('tells a POSIX terminal to run orca', () => {
    onPlatform('darwin')
    expect(
      predictSpawnOrchestrationCliCommand({
        connectionId: null,
        cwd: '/repo',
        projectRuntime: undefined,
        settings: {}
      })
    ).toBe('orca')
  })
})
