import { describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock, removeAllListenersMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    on: vi.fn(),
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  },
  app: {
    isPackaged: true,
    getPath: vi.fn().mockReturnValue('/tmp/orca-test-userdata')
  }
}))

vi.mock('fs', () => ({
  existsSync: () => true,
  statSync: () => ({ isDirectory: () => true, mode: 0o755 }),
  accessSync: () => undefined,
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: 'zsh',
    pid: 12345
  })
}))

vi.mock('../opencode/hook-service', () => ({
  openCodeHookService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

vi.mock('../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

import { registerPtyHandlers, registerSshPtyProvider, unregisterSshPtyProvider } from '../ipc/pty'
import type { IPtyProvider } from './types'

describe('PTY provider dispatch', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }
  }

  function setup(): void {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    registerPtyHandlers(mainWindow as never)
  }

  it('routes to local provider when connectionId is null', async () => {
    setup()
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      connectionId: null
    })) as { id: string }
    expect(result.id).toBeTruthy()
  })

  it('routes to local provider when connectionId is undefined', async () => {
    setup()
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    expect(result.id).toBeTruthy()
  })

  it('routes to SSH provider when connectionId is set', async () => {
    setup()
    const mockSshProvider: IPtyProvider = {
      spawn: vi.fn().mockResolvedValue({ id: 'ssh-pty-1' }),
      attach: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      listProcesses: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      onData: vi.fn().mockReturnValue(() => {}),
      onReplay: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn().mockReturnValue(() => {})
    }

    registerSshPtyProvider('conn-123', mockSshProvider)

    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      connectionId: 'conn-123'
    })) as { id: string }

    expect(result.id).toBe('ssh-pty-1')
    expect(mockSshProvider.spawn).toHaveBeenCalledWith({
      cols: 80,
      rows: 24,
      cwd: undefined,
      env: undefined
    })

    unregisterSshPtyProvider('conn-123')
  })

  it('throws for unknown connectionId', async () => {
    setup()
    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        connectionId: 'unknown-conn'
      })
    ).rejects.toThrow('No PTY provider for connection "unknown-conn"')
  })

  it('unregisterSshPtyProvider removes the provider', async () => {
    setup()
    const mockProvider: IPtyProvider = {
      spawn: vi.fn().mockResolvedValue({ id: 'ssh-pty-2' }),
      attach: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      listProcesses: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      onData: vi.fn().mockReturnValue(() => {}),
      onReplay: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn().mockReturnValue(() => {})
    }

    registerSshPtyProvider('conn-456', mockProvider)
    unregisterSshPtyProvider('conn-456')

    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        connectionId: 'conn-456'
      })
    ).rejects.toThrow('No PTY provider for connection "conn-456"')
  })
})
