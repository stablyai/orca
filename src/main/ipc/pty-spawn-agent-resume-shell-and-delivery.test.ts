// Pins the two host-owned halves of a cold-restore agent resume that the client
// used to own: which shell the resume argv is quoted for (#12320), and that an
// SSH resume command waits for the remote shell's ready marker. Both are set on
// `args` inside the `pty:spawn` handler, so only a spawn through the handler
// observes them — asserting the pieces in isolation leaves the wiring untested.

import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers, registerSshPtyProvider } from './pty'

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

/** The pre-U5 config the renderer surrenders on the first resume of a sleeping
 *  session; `agentCommand` is already complete, so only the resume argv is quoted. */
const LEGACY_LAUNCH_CONFIG = {
  agentCommand: 'codex',
  agentArgs: '',
  agentEnv: {}
}

/** Distinct ids per case: the host record store is process-global, and the first
 *  resume of a key persists the surrendered config under its execution owner. */
function resumeLaunch(providerSessionId: string) {
  return {
    resume: {
      operation: 'resume',
      sessionKey: { worktreeId: 'wt-1', baseAgent: 'codex', providerSessionId }
    }
  } as const
}

describe('registerPtyHandlers agent resume', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()

  async function withWin32Platform<T>(fn: () => Promise<T>): Promise<T> {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      return await fn()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  }

  async function spawnLocalWin32Resume(shellOverride?: string): Promise<string | undefined> {
    const spawn = installDaemonTestProvider()
    handlers.clear()
    registerPtyHandlers(mainWindow as never, undefined, undefined, (() => ({
      terminalWindowsShell: 'powershell.exe'
    })) as never)
    await withWin32Platform(async () => {
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo',
        worktreeId: 'wt-1',
        ...(shellOverride ? { shellOverride } : {}),
        agentLaunch: resumeLaunch('codex-local'),
        launchConfig: LEGACY_LAUNCH_CONFIG
      })
    })
    return (spawn.mock.calls[0]?.[0] as { command?: string } | undefined)?.command
  }

  // #12320: the pane's tab shell decides the quoting, and only this handler knows
  // it. Dropping `shellOverride` here leaves cmd.exe panes with PowerShell quotes,
  // which reach codex verbatim as part of the session id.
  it('quotes the resume argv for the pane tab shell, not the global Windows shell', async () => {
    expect(await spawnLocalWin32Resume('cmd.exe')).toBe(`codex "resume" "codex-local"`)
    expect(await spawnLocalWin32Resume()).toBe(`codex 'resume' 'codex-local'`)
  })

  // The renderer used to set this while it built the command. On the host-owned
  // path only the host can, and without it the remote shell eats the command as
  // it prints its own startup banner.
  it('gates an SSH resume command on the remote shell ready marker', async () => {
    const spawn = vi.fn(async () => ({ id: 'remote-pty' }))
    registerSshPtyProvider('ssh-resume', {
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      acknowledgeDataEvent: vi.fn()
    } as never)
    handlers.clear()
    registerPtyHandlers(mainWindow as never, undefined, undefined, (() => ({})) as never)

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      connectionId: 'ssh-resume',
      cwd: '/home/me/wt-1',
      worktreeId: 'wt-1',
      agentLaunch: resumeLaunch('codex-ssh'),
      launchConfig: LEGACY_LAUNCH_CONFIG,
      // Legacy provenance: the session was captured on this same connection.
      legacyResumeRecordedConnectionId: 'ssh-resume'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: `codex 'resume' 'codex-ssh'`,
        commandDelivery: 'provider',
        startupCommandDelivery: 'shell-ready'
      })
    )
  })

  it('quotes a native-Windows SSH resume for the relay default shell', async () => {
    const spawn = vi.fn(async () => ({ id: 'remote-win-pty' }))
    const getDefaultShell = vi.fn(async () => 'C:\\Windows\\System32\\cmd.exe')
    registerSshPtyProvider('ssh-win-resume', {
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell,
      getProfiles: vi.fn(),
      acknowledgeDataEvent: vi.fn()
    } as never)
    handlers.clear()
    registerPtyHandlers(mainWindow as never, undefined, undefined, (() => ({})) as never)

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      connectionId: 'ssh-win-resume',
      cwd: 'C:\\Users\\me\\wt-1',
      agentLaunch: resumeLaunch('codex-ssh-win-cmd'),
      launchConfig: LEGACY_LAUNCH_CONFIG,
      legacyResumeRecordedConnectionId: 'ssh-win-resume'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: `codex "resume" "codex-ssh-win-cmd"` })
    )
    expect(getDefaultShell).toHaveBeenCalledOnce()
  })
})
