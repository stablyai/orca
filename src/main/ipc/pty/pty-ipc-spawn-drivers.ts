import { vi } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import { registerPtyHandlers } from './register-handlers'
import { accessSyncMock, spawnMock, statSyncMock } from './pty-ipc-mock-registry'
import { BUNDLED_CLI_PATH, BUNDLED_RESOURCES_PATH } from './pty-ipc-test-constants'

type IpcHandlerMap = Map<string, (_event: unknown, args: unknown) => unknown>

type MockMainWindow = {
  webContents: {
    on: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    removeListener: ReturnType<typeof vi.fn>
  }
}

export function createPtyIpcSpawnDrivers(ctx: {
  handlers: IpcHandlerMap
  mainWindow: MockMainWindow
  createMockProc: () => { emitData: (data: string) => void }
}) {
  const { handlers, mainWindow, createMockProc } = ctx
  async function spawnAndGetEnv(
    argsEnv?: Record<string, string>,
    processEnvOverrides?: Record<string, string | undefined>,
    getSelectedCodexHomePath?: (
      target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null },
      launchEnv?: NodeJS.ProcessEnv,
      launchContext?: { unavailableManagedHomePath?: string }
    ) => string | null,
    getSettings?: () => {
      agentStatusHooksEnabled?: boolean
      disabledTuiAgents?: TuiAgent[]
      httpProxyUrl?: string
      httpProxyBypassRules?: string
    },
    command?: string,
    launchAgent?: TuiAgent,
    cwd?: string,
    worktreeId?: string
  ): Promise<Record<string, string>> {
    const savedEnv: Record<string, string | undefined> = {}
    if (processEnvOverrides) {
      for (const [k, v] of Object.entries(processEnvOverrides)) {
        savedEnv[k] = process.env[k]
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
    }

    try {
      handlers.clear()
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        getSelectedCodexHomePath,
        getSettings as never
      )
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        ...(argsEnv ? { env: argsEnv } : {}),
        ...(command ? { command } : {}),
        ...(launchAgent ? { launchAgent } : {}),
        ...(cwd ? { cwd } : {}),
        ...(worktreeId ? { worktreeId } : {})
      })
      const spawnCall = spawnMock.mock.calls.at(-1)!
      return spawnCall[2].env as Record<string, string>
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
    }
  }

  async function spawnAndGetCall(args?: {
    cwd?: string
    env?: Record<string, string>
    command?: string
  }): Promise<[string, string[], { cwd: string; env: Record<string, string> }]> {
    handlers.clear()
    registerPtyHandlers(mainWindow as never)
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      ...args
    })
    return spawnMock.mock.calls.at(-1) as [
      string,
      string[],
      { cwd: string; env: Record<string, string> }
    ]
  }

  // Codex preflight needs a bundled launcher that passes the executable check.
  async function withBundledCli<T>(
    run: () => Promise<T>,
    options?: { launcherExecutable?: boolean }
  ): Promise<T> {
    const launcherExecutable = options?.launcherExecutable ?? true
    const previousResourcesPath = process.resourcesPath
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: BUNDLED_RESOURCES_PATH
    })
    // Make only the launcher executable; preserve permissive stat/access defaults for other fixtures.
    statSyncMock.mockImplementation((target: string) => ({
      isDirectory: () => target !== BUNDLED_CLI_PATH,
      isFile: () => target === BUNDLED_CLI_PATH,
      mode: 0o755,
      size: 1
    }))
    if (!launcherExecutable) {
      accessSyncMock.mockImplementation((target: string) => {
        if (target === BUNDLED_CLI_PATH) {
          throw new Error(`EACCES: ${target}`)
        }
      })
    }
    try {
      return await run()
    } finally {
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: previousResourcesPath
      })
    }
  }
  /** Saturates one PTY to its 512 KiB in-flight cap; leaves 88 KiB pending and no timers scheduled. */
  async function spawnAndSaturateRendererDeliveryGate(
    mockProc: ReturnType<typeof createMockProc>
  ): Promise<{ id: string }> {
    registerPtyHandlers(mainWindow as never)
    const spawnResult = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp'
    })) as { id: string }
    mainWindow.webContents.send.mockClear()
    mockProc.emitData('x'.repeat(600 * 1024))
    vi.advanceTimersByTime(8)
    for (let index = 0; index < 32; index++) {
      vi.advanceTimersByTime(1)
    }
    return spawnResult
  }

  return { spawnAndGetEnv, spawnAndGetCall, withBundledCli, spawnAndSaturateRendererDeliveryGate }
}
