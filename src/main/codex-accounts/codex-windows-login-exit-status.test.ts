import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AuthSnapshot from './codex-login-auth-snapshot'

class LoginChild extends EventEmitter {
  stdout = null
  stderr: PassThrough | null = null
  pid = 4242
  exitCode = null
  signalCode = null
  kill = vi.fn(() => true)
}

const mocks = vi.hoisted(() => ({
  exitCode: vi.fn<() => number | null>(),
  readAuth: vi.fn<() => string | null | undefined>(),
  cleanup: vi.fn()
}))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'C:\\Tools\\codex.exe' }))
vi.mock('./codex-login-auth-snapshot', async () => {
  const actual = await vi.importActual<typeof AuthSnapshot>('./codex-login-auth-snapshot')
  return { ...actual, readLoginAuthSnapshot: mocks.readAuth }
})
vi.mock('../../shared/windows-interactive-login-spawn', () => ({
  buildWindowsHostInteractiveLoginSpawn: () => ({
    command: 'cmd.exe',
    args: [],
    stdio: 'ignore',
    windowsHide: true,
    cleanup: mocks.cleanup,
    getExitCode: mocks.exitCode,
    getTerminationPid: () => 4242,
    waitForTerminationPid: async () => 4242
  })
}))

import { runCodexLoginSession } from './codex-login-session'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  mocks.exitCode.mockReset().mockReturnValue(0)
  mocks.readAuth.mockReset().mockReturnValue('existing credential')
  mocks.cleanup.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', originalPlatform)
})

function startLogin() {
  const child = new LoginChild()
  child.stderr = new PassThrough()
  const spawn = vi.fn(() => child)
  const kill = vi.fn()
  let cancel: (() => boolean) | undefined
  const login = runCodexLoginSession('C:\\orca-test-login', {
    wslCommand: 'wsl.exe',
    spawn,
    killProcessTree: kill,
    setCancel: (callback) => {
      cancel = callback
    },
    onAuthUrl: vi.fn()
  })
  return { child, spawn, kill, login, cancel: () => cancel?.() }
}

describe('Codex Windows login completion', () => {
  it.each([7, null])(
    'rejects wrapper zero and unchanged credentials with CLI completion %s',
    async (code) => {
      mocks.exitCode.mockReturnValue(code)
      const { child, login } = startLogin()
      const rejection = expect(login).rejects.toThrow(
        code === null ? 'did not report a completion status' : 'exited with code 7'
      )
      child.emit('close', 0)
      await rejection
      expect(mocks.cleanup).toHaveBeenCalledOnce()
      expect(child.listenerCount('close')).toBe(0)
    }
  )

  it('accepts a recorded zero exit despite diagnostic stderr', async () => {
    const { child, login } = startLogin()
    child.stderr?.write('diagnostic warning\n')
    child.emit('close', 0)
    await expect(login).resolves.toBeUndefined()
  })

  it('trusts recorded CLI zero without requiring credentials to be rewritten', async () => {
    const { child, login } = startLogin()
    child.emit('close', 0)
    await expect(login).resolves.toBeUndefined()
  })

  it('does not reinterpret a successful CLI completion when auth is temporarily unreadable', async () => {
    const { child, login } = startLogin()
    mocks.readAuth.mockReturnValue(undefined)
    child.emit('close', 0)
    await expect(login).resolves.toBeUndefined()
  })

  it('captures completion before cleanup removes it', async () => {
    mocks.cleanup.mockImplementation(() => mocks.exitCode.mockReturnValue(null))
    const { child, login } = startLogin()
    child.emit('close', 0)
    await expect(login).resolves.toBeUndefined()
  })

  it('does not accept changed credentials without a CLI completion', async () => {
    mocks.exitCode.mockReturnValue(null)
    const { child, login } = startLogin()
    mocks.readAuth.mockReturnValue('new credential')
    const rejection = expect(login).rejects.toThrow('did not report a completion status')
    child.emit('close', 0)
    await rejection
  })

  it('does not override a recorded CLI failure with fresh credentials before a controlled kill', async () => {
    mocks.exitCode.mockReturnValue(7)
    const { child, login } = startLogin()
    mocks.readAuth.mockReturnValue('new credential')
    const rejection = expect(login).rejects.toThrow('exited with code 7')
    child.emit('close', 0)
    await rejection
  })

  it('rejects an actual process launch error even if its completion fixture says zero', async () => {
    const { child, login } = startLogin()
    const rejection = expect(login).rejects.toThrow('access denied')
    child.emit('error', new Error('access denied'))
    await rejection
    expect(mocks.cleanup).toHaveBeenCalledOnce()
  })

  it('keeps cancellation independent of absent completion evidence', async () => {
    mocks.exitCode.mockReturnValue(null)
    const { login, cancel, kill } = startLogin()
    const rejection = expect(login).rejects.toThrow('Codex sign-in was cancelled.')
    expect(cancel()).toBe(true)
    await rejection
    expect(kill).toHaveBeenCalledOnce()
  })

  it.each([undefined, null])(
    'preserves the proved post-auth kill verdict when final auth is %s',
    async (finalAuth) => {
      vi.useFakeTimers()
      mocks.exitCode.mockReturnValue(null)
      const { child, login, kill, cancel } = startLogin()
      mocks.readAuth.mockReturnValue('new credential')
      expect(cancel()).toBe(false)
      await vi.advanceTimersByTimeAsync(5_500)
      expect(kill).toHaveBeenCalledOnce()
      mocks.readAuth.mockReturnValue(finalAuth)
      const verdict =
        finalAuth === null
          ? expect(login).rejects.toThrow('did not report a completion status')
          : expect(login).resolves.toBeUndefined()
      child.emit('close', 1)
      await verdict
    }
  )
})
