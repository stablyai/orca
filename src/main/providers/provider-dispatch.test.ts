import { describe, expect, it, vi } from 'vitest'

const { handleMock, onMock, removeHandlerMock, removeAllListenersMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: vi.fn().mockReturnValue('/tmp/orca-test-userdata')
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}))

vi.mock('fs', () => ({
  existsSync: () => true,
  statSync: () => ({ isDirectory: () => true, mode: 0o755 }),
  accessSync: () => undefined,
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
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

import {
  deletePtyOwnership,
  registerPtyHandlers,
  registerSshPtyProvider,
  setPtyOwnership,
  unregisterSshPtyProvider
} from '../ipc/pty'
import type { IPtyProvider } from './types'

describe('PTY provider dispatch', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }
  }
  const mainWindowIpcEvent = { sender: mainWindow.webContents }

  function setup(): void {
    handlers.clear()
    handleMock.mockReset()
    onMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    onMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    registerPtyHandlers(mainWindow as never)
  }

  function createMockProvider(id: string): IPtyProvider {
    return {
      spawn: vi.fn().mockResolvedValue({ id }),
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
    const mockSshProvider = createMockProvider('ssh-pty-1')

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
    const mockProvider = createMockProvider('ssh-pty-2')

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

  it('keeps same relay PTY ids distinct across SSH targets', () => {
    setup()
    const providerA = createMockProvider('ssh:conn-a@@pty-1')
    const providerB = createMockProvider('ssh:conn-b@@pty-1')
    registerSshPtyProvider('conn-a', providerA)
    registerSshPtyProvider('conn-b', providerB)
    setPtyOwnership('ssh:conn-a@@pty-1', 'conn-a')
    setPtyOwnership('ssh:conn-b@@pty-1', 'conn-b')

    try {
      const write = handlers.get('pty:write') as (event: unknown, args: unknown) => void
      write(mainWindowIpcEvent, { id: 'ssh:conn-a@@pty-1', data: 'a' })
      write(mainWindowIpcEvent, { id: 'ssh:conn-b@@pty-1', data: 'b' })

      expect(providerA.write).toHaveBeenCalledWith('ssh:conn-a@@pty-1', 'a')
      expect(providerB.write).toHaveBeenCalledWith('ssh:conn-b@@pty-1', 'b')
      expect(providerA.write).not.toHaveBeenCalledWith('ssh:conn-b@@pty-1', expect.anything())
      expect(providerB.write).not.toHaveBeenCalledWith('ssh:conn-a@@pty-1', expect.anything())
    } finally {
      deletePtyOwnership('ssh:conn-a@@pty-1')
      deletePtyOwnership('ssh:conn-b@@pty-1')
      unregisterSshPtyProvider('conn-a')
      unregisterSshPtyProvider('conn-b')
    }
  })
})
