import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runClaudeCommandProcess } from './claude-command-process'

const spawnProcess = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spawnProcess
}))
vi.mock('../../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveClaudeCommand: () => 'C:\\Tools\\claude.exe'
}))
vi.mock('../../providers/shell-launch/windows/windows-interactive-login-spawn', async () => {
  const { fakeWindowsInteractiveLoginSpawn } =
    await import('../../providers/shell-launch/windows/windows-interactive-login-spawn.test-fixture')
  return { buildWindowsHostInteractiveLoginSpawn: () => fakeWindowsInteractiveLoginSpawn(1) }
})

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
})

describe('runClaudeCommandProcess', () => {
  it('fails a Windows login whose relayed exit code is non-zero although start /wait exits 0', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    spawnProcess.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, stdin: null })
      setImmediate(() => child.emit('exit', 0))
      return child
    })

    await expect(
      runClaudeCommandProcess(
        ['auth', 'login', '--claudeai'],
        { windowsPath: 'C:\\claude-home', linuxPath: null, wslDistro: null },
        10_000
      )
    ).rejects.toThrow('Claude command exited with code 1.')
  })
})
