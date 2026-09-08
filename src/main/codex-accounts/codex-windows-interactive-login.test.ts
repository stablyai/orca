import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type * as NodeOs from 'node:os'
import { getCmdExePath } from '../../shared/windows-batch-spawn'
import {
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
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('Codex Windows host interactive login', () => {
  registerCodexAccountsTestHomes()

  it('resolves a Windows login whose child has no piped streams', async () => {
    vi.resetModules()
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const child = new EventEmitter() as EventEmitter & {
      stdout: null
      stderr: null
      kill: ReturnType<typeof vi.fn>
      pid: number
    }
    child.stdout = null
    child.stderr = null
    child.kill = vi.fn()
    child.pid = 4242
    const spawnMock = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0))
      return child
    })
    const buildInteractiveLoginSpawn = vi.fn(() => ({
      command: getCmdExePath(),
      args: ['/d', '/c', 'start', '', '/wait', 'C:\\Tools\\codex.cmd', 'login'],
      stdio: 'ignore' as const,
      windowsHide: true
    }))
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'C:\\Tools\\codex.cmd'
    }))
    vi.doMock('../../shared/windows-interactive-login-spawn', () => ({
      buildWindowsHostInteractiveLoginSpawn: buildInteractiveLoginSpawn
    }))

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        createStore(createSettings()) as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )
      await (
        service as unknown as {
          runCodexLogin(managedHomePath: string): Promise<void>
        }
      ).runCodexLogin(testState.fakeHomeDir)

      expect(buildInteractiveLoginSpawn).toHaveBeenCalledWith('C:\\Tools\\codex.cmd', ['login'])
      expect(spawnMock).toHaveBeenCalledWith(
        getCmdExePath(),
        expect.arrayContaining(['start', '', '/wait']),
        expect.objectContaining({
          stdio: 'ignore',
          windowsHide: true
        })
      )
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
      vi.doUnmock('../../shared/windows-interactive-login-spawn')
    }
  })
})
