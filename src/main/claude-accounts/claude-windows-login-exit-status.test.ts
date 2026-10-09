import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class LoginChild extends EventEmitter {
  stdout = null
  stderr: PassThrough | null = null
  stdin = null
  pid = 0
  kill = vi.fn(() => true)
}

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  exitCode: vi.fn<() => number | null>(),
  cleanup: vi.fn()
}))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: mocks.spawn }))
vi.mock('../codex-cli/command', () => ({ resolveClaudeCommand: () => 'C:\\Tools\\claude.exe' }))
vi.mock('../../shared/windows-interactive-login-spawn', () => ({
  buildWindowsHostInteractiveLoginSpawn: () => ({
    command: 'cmd.exe',
    args: [],
    stdio: 'ignore',
    windowsHide: true,
    cleanup: mocks.cleanup,
    getExitCode: mocks.exitCode,
    getTerminationPid: () => null,
    waitForTerminationPid: async () => null
  })
}))

import { runClaudeCommandProcess } from './claude-command-process'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const config = { windowsPath: 'C:\\orca-test-login', linuxPath: null, wslDistro: null }

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  mocks.exitCode.mockReset().mockReturnValue(0)
  mocks.cleanup.mockReset()
  mocks.spawn.mockReset()
})
afterEach(() => Object.defineProperty(process, 'platform', originalPlatform))

describe('Claude Windows login completion', () => {
  it.each([7, null])('rejects a clean wrapper exit with CLI completion %s', async (code) => {
    const child = new LoginChild()
    mocks.spawn.mockReturnValue(child)
    mocks.exitCode.mockReturnValue(code)
    const login = runClaudeCommandProcess(['auth', 'login'], config, 1000)
    const rejection = expect(login).rejects.toThrow(
      code === null ? 'did not report a completion status' : 'exited with code 7'
    )
    child.emit('exit', 0)
    await rejection
    expect(mocks.cleanup).toHaveBeenCalledOnce()
    expect(child.listenerCount('exit')).toBe(0)
  })

  it('accepts a recorded zero exit despite diagnostic stderr', async () => {
    const child = new LoginChild()
    child.stderr = new PassThrough()
    mocks.spawn.mockReturnValue(child)
    const login = runClaudeCommandProcess(['auth', 'login'], config, 1000)
    child.stderr.write('diagnostic warning\n')
    child.emit('exit', 0)
    await expect(login).resolves.toBe('diagnostic warning\n')
  })

  it('uses completion evidence captured before cleanup', async () => {
    const child = new LoginChild()
    mocks.spawn.mockReturnValue(child)
    mocks.cleanup.mockImplementation(() => mocks.exitCode.mockReturnValue(null))
    const login = runClaudeCommandProcess(['auth', 'login'], config, 1000)
    child.emit('exit', 0)
    await expect(login).resolves.toBe('')
  })

  it('rejects a process launch error even if a stale completion fixture says zero', async () => {
    const child = new LoginChild()
    mocks.spawn.mockReturnValue(child)
    const login = runClaudeCommandProcess(['auth', 'login'], config, 1000)
    const rejection = expect(login).rejects.toThrow('access denied')
    child.emit('error', new Error('access denied'))
    await rejection
    expect(mocks.cleanup).toHaveBeenCalledOnce()
  })

  it('preserves explicit allowFailure for a recorded CLI failure', async () => {
    const child = new LoginChild()
    mocks.spawn.mockReturnValue(child)
    mocks.exitCode.mockReturnValue(7)
    const login = runClaudeCommandProcess(['auth', 'login'], config, 1000, { allowFailure: true })
    child.emit('exit', 0)
    await expect(login).resolves.toBe('')
  })

  it('requires completion proof even when allowFailure was requested', async () => {
    const child = new LoginChild()
    mocks.spawn.mockReturnValue(child)
    mocks.exitCode.mockReturnValue(null)
    const login = runClaudeCommandProcess(['auth', 'login'], config, 1000, { allowFailure: true })
    const rejection = expect(login).rejects.toThrow('did not report a completion status')
    child.emit('exit', 0)
    await rejection
  })

  it('keeps cancellation independent of absent completion evidence', async () => {
    const child = new LoginChild()
    mocks.spawn.mockReturnValue(child)
    mocks.exitCode.mockReturnValue(null)
    const controller = new AbortController()
    const login = runClaudeCommandProcess(['auth', 'login'], config, 1000, {
      signal: controller.signal
    })
    const rejection = expect(login).rejects.toThrow('Claude sign-in was cancelled.')
    controller.abort()
    await rejection
    expect(child.kill).toHaveBeenCalledOnce()
  })
})
