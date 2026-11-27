import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnProcess, resolveClaudeCommand } = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
  resolveClaudeCommand: vi.fn()
}))

vi.mock('@orca/process-host', () => ({ spawnProcess }))
vi.mock('../../codex-cli/command', () => ({ resolveClaudeCommand }))
vi.mock('../../providers/shell-launch/windows/windows-interactive-login-spawn', () => ({
  buildWindowsHostInteractiveLoginSpawn: () => ({
    command: 'cmd.exe',
    args: [],
    stdio: 'ignore',
    windowsHide: true,
    cleanup: async () => {},
    getTerminationPid: () => null,
    waitForTerminationPid: async () => null,
    readExitCode: async () => 1
  })
}))

import { runClaudeCommandProcess } from './claude-command-process'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

function runWindowsLogin(resolvedCommand: string): Promise<string> {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  resolveClaudeCommand.mockReturnValue(resolvedCommand)
  const child = new EventEmitter()
  spawnProcess.mockReturnValue(child)
  const login = runClaudeCommandProcess(
    ['auth', 'login'],
    { windowsPath: 'C:\\config', linuxPath: null, wslDistro: null },
    60_000
  )
  child.emit('exit', 0)
  return login
}

describe('runClaudeCommandProcess Windows interactive login', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
  })

  it('reports a missing CLI when no install was resolved', async () => {
    await expect(runWindowsLogin('claude')).rejects.toThrow('Claude Code CLI not found.')
  })

  it('reports the exit code when a resolved install fails', async () => {
    await expect(runWindowsLogin('C:\\Tools\\claude.exe')).rejects.toThrow(
      'Claude command exited with code 1.'
    )
  })
})
