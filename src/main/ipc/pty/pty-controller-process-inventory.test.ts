import { openCodeHookServiceModuleMock } from '../pty-ipc-mock-registry'
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
  },
  powerMonitor: {
    on: vi.fn()
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

vi.mock('../../opencode/hook-service', () => openCodeHookServiceModuleMock())

vi.mock('../../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

import { registerPtyHandlers } from './register-handlers'
import { setLocalPtyProvider } from './provider/registry'
import type { IPtyProvider } from '../../providers/pty-provider-contract'
import type { PtyProcessInfo } from '../../providers/pty-process-info'

// An unreachable relay must not invalidate all host inventories and leave exited panes active on mobile (STA-517).

type ListCall = { opts: { deadlineMs?: number } | undefined }

function createProvider(
  sessions: PtyProcessInfo[],
  behavior: 'ok' | 'reject' = 'ok'
): { provider: IPtyProvider; calls: ListCall[] } {
  const calls: ListCall[] = []
  const provider = {
    onData: vi.fn().mockReturnValue(() => {}),
    onRejectedData: vi.fn().mockReturnValue(() => {}),
    onReplay: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn().mockReturnValue(() => {}),
    listProcesses: vi.fn(async (opts?: { deadlineMs?: number }) => {
      calls.push({ opts })
      if (behavior === 'reject') {
        throw new Error('relay unreachable')
      }
      return sessions
    })
  } as unknown as IPtyProvider
  return { provider, calls }
}

const mainWindow = {
  isDestroyed: () => false,
  webContents: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }
}

function captureController(): {
  listProcesses: (hostId?: string, opts?: { deadlineMs?: number }) => Promise<PtyProcessInfo[]>
} {
  handleMock.mockReset()
  onMock.mockReset()
  handleMock.mockImplementation(() => {})
  onMock.mockImplementation(() => {})
  let controller: { listProcesses?: unknown } | undefined
  const runtime = {
    setPtyController: vi.fn((next: { listProcesses?: unknown }) => {
      controller = next
    }),
    createPreAllocatedTerminalHandle: vi.fn(() => 'term_test'),
    registerPreAllocatedHandleForPty: vi.fn(),
    registerPty: vi.fn()
  }
  registerPtyHandlers(mainWindow as never, runtime as never)
  if (typeof controller?.listProcesses !== 'function') {
    throw new Error('PTY controller listProcesses was not registered')
  }
  return controller as never
}

describe('aggregate PTY process inventory', () => {
  it('fails the aggregate when the local provider cannot list', async () => {
    const local = createProvider([], 'reject')
    setLocalPtyProvider(local.provider)
    const controller = captureController()

    // Local controller failure must preserve uncertainty instead of proving every local PTY dead.
    await expect(controller.listProcesses()).rejects.toThrow('relay unreachable')
  })
})
