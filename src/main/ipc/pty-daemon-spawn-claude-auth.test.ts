import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { registerPtyHandlers } from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

const mainWindow = {
  isDestroyed: () => false,
  isFocused: () => true,
  isVisible: () => true,
  isMinimized: () => false,
  webContents: {
    on: vi.fn(),
    send: vi.fn(),
    removeListener: vi.fn()
  }
}

describe('Claude auth preservation on structured TUI spawn', () => {
  it('preserves host-pinned Claude auth for a structured TUI launch', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        command: string
        launchAgent: 'claude'
        preserveClaudeAuthEnv: true
        env: Record<string, string>
      }): Promise<{ id: string }>
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      preAllocateHandleForPty: vi.fn(),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    const prepareClaudeAuth = vi.fn(async () => ({
      configDir: '/selected/claude',
      envPatch: { CLAUDE_CONFIG_DIR: '/selected/claude' },
      stripAuthEnv: true,
      provenance: 'managed:selected'
    }))

    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      prepareClaudeAuth
    )
    const spawnController = controller as unknown as RuntimeSpawnController
    await spawnController.spawn({
      cols: 80,
      rows: 24,
      command: 'claude --setting-sources user,project,local --resume provider-session',
      launchAgent: 'claude',
      preserveClaudeAuthEnv: true,
      env: {
        CLAUDE_CONFIG_DIR: '/pinned/claude',
        ANTHROPIC_AUTH_TOKEN: 'pinned-gateway-token'
      }
    })

    expect(prepareClaudeAuth).not.toHaveBeenCalled()
    expect(spawnMock.mock.calls.at(-1)?.[2]?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/pinned/claude',
      ANTHROPIC_AUTH_TOKEN: 'pinned-gateway-token'
    })
  })
})
