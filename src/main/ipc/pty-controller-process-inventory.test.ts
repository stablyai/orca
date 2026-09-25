import { afterEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('../opencode/hook-service', () => ({
  openCodeHookService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

vi.mock('../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

import {
  registerPtyHandlers,
  registerSshPtyProvider,
  setLocalPtyProvider,
  unregisterSshPtyProvider
} from './pty'
import type { IPtyProvider, PtyProcessInfo } from '../providers/types'

// The runtime's worktree.ps liveness refresh calls the aggregate inventory (no connectionId)
// under a 3s budget, and only a returned inventory can retire an exited PTY. STA-517: one
// unreachable relay made the whole aggregate fail, so no PTY was ever proven dead and every
// retained pane — the SSH ones above all — kept reporting "active" to mobile indefinitely.

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

function session(id: string): PtyProcessInfo {
  return { id, cwd: '/tmp', title: id } as unknown as PtyProcessInfo
}

const mainWindow = {
  isDestroyed: () => false,
  webContents: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }
}

function captureController(): {
  listProcesses: (
    connectionId?: string | null,
    opts?: { deadlineMs?: number }
  ) => Promise<PtyProcessInfo[]>
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
  const registered: string[] = []

  function register(connectionId: string, provider: IPtyProvider): void {
    registerSshPtyProvider(connectionId, provider)
    registered.push(connectionId)
  }

  afterEach(() => {
    for (const connectionId of registered.splice(0)) {
      unregisterSshPtyProvider(connectionId)
    }
  })

  it('still reports local and healthy relays when one SSH relay rejects', async () => {
    const local = createProvider([session('local-pty')])
    const healthy = createProvider([session('ssh:conn-ok@@pty')])
    const broken = createProvider([], 'reject')
    setLocalPtyProvider(local.provider)
    register('conn-ok', healthy.provider)
    register('conn-broken', broken.provider)
    const controller = captureController()

    const sessions = await controller.listProcesses()

    // Pre-fix this rejected: Promise.all surfaced the broken relay's error, the runtime
    // read it as "no inventory", and no PTY anywhere was retired.
    expect(sessions.map((entry) => entry.id).sort()).toEqual(['local-pty', 'ssh:conn-ok@@pty'])
  })

  it('bounds every relay list by the caller deadline instead of the mux default', async () => {
    const local = createProvider([session('local-pty')])
    const remote = createProvider([session('ssh:conn-a@@pty')])
    setLocalPtyProvider(local.provider)
    register('conn-a', remote.provider)
    const controller = captureController()
    const deadlineMs = Date.now() + 2500

    await controller.listProcesses(undefined, { deadlineMs })

    // Without a forwarded deadline an unanswered relay list runs to the SSH mux's own
    // 30s default, far past the runtime's 3s budget for the whole refresh.
    expect(remote.calls).toEqual([{ opts: { deadlineMs } }])
  })

  it('forwards the caller deadline on a targeted single-connection list', async () => {
    const local = createProvider([session('local-pty')])
    const remote = createProvider([session('ssh:conn-a@@pty')])
    setLocalPtyProvider(local.provider)
    register('conn-a', remote.provider)
    const controller = captureController()
    const deadlineMs = Date.now() + 1200

    await controller.listProcesses('conn-a', { deadlineMs })

    expect(remote.calls).toEqual([{ opts: { deadlineMs } }])
  })

  it('fails the aggregate when the local provider cannot list', async () => {
    const local = createProvider([], 'reject')
    setLocalPtyProvider(local.provider)
    const controller = captureController()

    // A local failure is a real controller fault, not one unreachable host: the runtime must
    // keep treating it as "no inventory" rather than proving every local PTY dead.
    await expect(controller.listProcesses()).rejects.toThrow('relay unreachable')
  })
})
