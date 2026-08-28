import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  createCodexAuthJson,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexAccountService config sync', () => {
  registerCodexAccountsTestHomes()

  it('removes command listeners when Codex login times out', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))

    try {
      const settings = createSettings()
      const store = createStore(settings)
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )
      const loginPromise = (
        service as unknown as {
          runCodexLogin(managedHomePath: string): Promise<void>
        }
      ).runCodexLogin(testState.fakeHomeDir)
      const rejection = expect(loginPromise).rejects.toThrow(
        'Codex sign-in took too long to finish.'
      )

      await vi.advanceTimersByTimeAsync(120_000)

      await rejection
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
    }
  })

  it('force-kills a lingering Windows codex login tree once auth.json exists', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
      pid: number
      exitCode: number | null
      signalCode: string | null
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    child.pid = 4242
    child.exitCode = null
    child.signalCode = null
    const execFileSyncMock = vi.fn()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))

    try {
      const store = createStore(createSettings())
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )
      const loginPromise = (
        service as unknown as {
          runCodexLogin(managedHomePath: string): Promise<void>
        }
      ).runCodexLogin(testState.fakeHomeDir)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(execFileSyncMock).not.toHaveBeenCalled()

      // Codex finishes the login (auth.json exists) but never exits on its own.
      writeFileSync(
        join(testState.fakeHomeDir, 'auth.json'),
        createCodexAuthJson('user@example.com', 'provider-account-1', 'refresh-token'),
        'utf-8'
      )
      await vi.advanceTimersByTimeAsync(6_000)
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '4242', '/t', '/f'],
        expect.objectContaining({ windowsHide: true, stdio: 'ignore' })
      )
      expect(child.kill).not.toHaveBeenCalled()

      // The forced non-zero exit still counts as a successful login.
      child.emit('close', 1)
      await expect(loginPromise).resolves.toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
    }
  })

  it('waits for reauthentication to replace existing Windows auth before killing login', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
      pid: number
      exitCode: number | null
      signalCode: string | null
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    child.pid = 4343
    child.exitCode = null
    child.signalCode = null
    const execFileSyncMock = vi.fn()
    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: vi.fn(() => child)
    }))
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
    const authPath = join(testState.fakeHomeDir, 'auth.json')
    writeFileSync(
      authPath,
      createCodexAuthJson('user@example.com', 'provider-account-1', 'old-token'),
      'utf-8'
    )

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        createStore(createSettings()) as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )
      const loginPromise = (
        service as unknown as { runCodexLogin(managedHomePath: string): Promise<void> }
      ).runCodexLogin(testState.fakeHomeDir)

      await vi.advanceTimersByTimeAsync(6_000)
      expect(execFileSyncMock).not.toHaveBeenCalled()

      writeFileSync(
        authPath,
        createCodexAuthJson('user@example.com', 'provider-account-1', 'new-token'),
        'utf-8'
      )
      await vi.advanceTimersByTimeAsync(6_000)
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '4343', '/t', '/f'],
        expect.objectContaining({ windowsHide: true, stdio: 'ignore' })
      )

      child.emit('close', 1)
      await expect(loginPromise).resolves.toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
    }
  })
})
