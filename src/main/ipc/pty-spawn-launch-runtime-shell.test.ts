import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { existsSyncMock, statSyncMock } from './pty-ipc-mock-registry'
import {
  automationSpawnRequest,
  createLaunchRuntimeStub,
  installSshTestProvider,
  lastProviderSpawnOptions,
  launchShellSettings,
  pickKeys,
  registerLaunchHandlers
} from './pty-spawn-launch-test-fixture'

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

const SHELL_KEYS = [
  'shellOverride',
  'terminalShellArgs',
  'terminalWindowsWslDistro',
  'terminalWindowsPowerShellImplementation'
] as const
const WSL_CWD = '\\\\wsl$\\Ubuntu\\home\\u\\repo'
const WINDOWS_CWD = 'C:\\repo'
const WINDOWS_ENV_KEYS = [
  'COMSPEC',
  'USERPROFILE',
  'SystemRoot',
  'ProgramW6432',
  'ProgramFiles',
  'ProgramFiles(x86)'
] as const
const hostPlatform = process.platform

const WSL_RUNTIME = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'repo-1:wsl:Ubuntu'
  }
} as const
const WINDOWS_HOST_RUNTIME = {
  status: 'resolved',
  runtime: {
    kind: 'windows-host',
    hostPlatform: 'win32',
    projectId: 'repo-1',
    reason: 'project-override',
    cacheKey: 'repo-1:windows-host'
  }
} as const

// Pins main's current launch behaviour as the convergence parity baseline (IPC_SSH_DEFAULT_SHELL, WINDOW_PANE, row 5): shell and runtime the pty:spawn assembler hands the provider.
describe('pty:spawn launch runtime and shell (window lane, main half)', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of WINDOWS_ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
    process.env.USERPROFILE = 'C:\\Users\\test'
    process.env.SystemRoot = 'C:\\Windows'
    process.env.ProgramW6432 = 'C:\\Program Files'
    process.env.ProgramFiles = 'C:\\Program Files'
    delete process.env['ProgramFiles(x86)']
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
    for (const key of WINDOWS_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
  })

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    if (platform === 'win32') {
      // Why: Windows shell resolution probes .exe candidates; dirs must still read as dirs.
      statSyncMock.mockImplementation((target: string) => {
        const isExe = /\.exe$/i.test(String(target))
        return { isDirectory: () => !isExe, isFile: () => isExe, size: 1024, mode: 0o755 }
      })
      existsSyncMock.mockReturnValue(true)
    }
  }

  async function spawnThroughProvider(
    request: Record<string, unknown>,
    settings: Record<string, unknown> = launchShellSettings()
  ): Promise<Record<string, unknown>> {
    const providerSpawn = vi.fn(async () => ({ id: 'launch-pty' }))
    if (typeof request.connectionId === 'string') {
      installSshTestProvider(request.connectionId, providerSpawn)
    } else {
      installDaemonTestProvider({ spawn: providerSpawn })
    }
    registerLaunchHandlers({ mainWindow, runtime: createLaunchRuntimeStub(), settings })
    await handlers.get('pty:spawn')!(null, request)
    return lastProviderSpawnOptions(providerSpawn)
  }

  // Pins main's current launch behaviour as the convergence parity baseline (IPC_SSH_DEFAULT_SHELL, rows 1/2/6 window panes): settings shell per host platform x local/SSH.
  describe('settings shell per host platform', () => {
    it.each([
      {
        platform: 'darwin',
        host: 'local',
        cwd: '/repo',
        expected: { shellOverride: '/bin/zsh', terminalShellArgs: ['-l'] }
      },
      {
        platform: 'linux',
        host: 'local',
        cwd: '/repo',
        expected: { shellOverride: '/bin/zsh', terminalShellArgs: ['-l'] }
      },
      {
        platform: 'win32',
        host: 'local',
        cwd: WINDOWS_CWD,
        // main today: the POSIX default-shell args ride along on the Windows settings shell.
        expected: {
          shellOverride: 'powershell.exe',
          terminalShellArgs: ['-l'],
          terminalWindowsWslDistro: null,
          terminalWindowsPowerShellImplementation: 'pwsh.exe'
        }
      },
      // main today: SSH forwards the client's trimmed terminalDefaultShell on every client OS, Windows included.
      {
        platform: 'darwin',
        host: 'ssh',
        cwd: '/home/u/repo',
        expected: { shellOverride: '/bin/zsh' }
      },
      {
        platform: 'linux',
        host: 'ssh',
        cwd: '/home/u/repo',
        expected: { shellOverride: '/bin/zsh' }
      },
      {
        platform: 'win32',
        host: 'ssh',
        cwd: '/home/u/repo',
        expected: { shellOverride: '/bin/zsh' }
      }
    ] as const)(
      '$platform $host pane gets $expected.shellOverride',
      async ({ platform, host, cwd, expected }) => {
        setPlatform(platform)
        const options = await spawnThroughProvider({
          cols: 80,
          rows: 24,
          cwd,
          worktreeId: `repo-1::${cwd}`,
          ...(host === 'ssh' ? { connectionId: 'ssh-1' } : {})
        })
        expect(pickKeys(options, SHELL_KEYS)).toEqual(expected)
      }
    )
  })

  // Pins main's current launch behaviour as the convergence parity baseline (WINDOW_PANE main half, rows 1/2/6 on Windows): projectRuntime x cwd -> shell and WSL distro.
  describe('Windows local projectRuntime x cwd', () => {
    // Repo panes send a resolved wsl/windows-host runtime; a folder pane with no candidate repo sends none.
    it.each([
      {
        pane: 'folder',
        runtime: undefined,
        cwd: WINDOWS_CWD,
        shell: 'powershell.exe',
        distro: null
      },
      {
        pane: 'folder',
        runtime: undefined,
        cwd: WSL_CWD,
        shell: 'powershell.exe',
        distro: 'Ubuntu'
      },
      { pane: 'repo', runtime: WSL_RUNTIME, cwd: WINDOWS_CWD, shell: 'wsl.exe', distro: 'Ubuntu' },
      { pane: 'repo', runtime: WSL_RUNTIME, cwd: WSL_CWD, shell: 'wsl.exe', distro: 'Ubuntu' },
      {
        pane: 'repo',
        runtime: WINDOWS_HOST_RUNTIME,
        cwd: WINDOWS_CWD,
        shell: 'powershell.exe',
        distro: null
      },
      {
        pane: 'repo',
        runtime: WINDOWS_HOST_RUNTIME,
        cwd: WSL_CWD,
        shell: 'powershell.exe',
        distro: 'Ubuntu'
      }
    ])(
      '$pane pane, runtime $runtime.runtime.kind, cwd $cwd -> $shell / $distro',
      async ({ runtime, cwd, shell, distro }) => {
        setPlatform('win32')
        const options = await spawnThroughProvider({
          cols: 80,
          rows: 24,
          cwd,
          worktreeId: `repo-1::${cwd}`,
          ...(runtime ? { projectRuntime: runtime } : {})
        })
        expect(pickKeys(options, ['shellOverride', 'terminalWindowsWslDistro'])).toEqual({
          shellOverride: shell,
          terminalWindowsWslDistro: distro
        })
      }
    )
  })

  // Pins main's current launch behaviour as the convergence parity baseline (row 5 automations, AUTOMATION_WSL_EXE main half): what shell a Windows automation runs in.
  describe('Windows desktop automation shell', () => {
    it('runs a \\\\wsl$ folder automation in the wsl.exe it requested', async () => {
      setPlatform('win32')
      const options = await spawnThroughProvider(
        automationSpawnRequest({
          cwd: WSL_CWD,
          worktreeId: `repo-1::${WSL_CWD}`,
          shellOverride: 'wsl.exe'
        })
      )
      expect(pickKeys(options, SHELL_KEYS)).toEqual({
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu',
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    })

    it('runs a WSL-forced C:\\ project automation in the settings shell', async () => {
      setPlatform('win32')
      // main today: the renderer quoted the command for WSL but sends no shellOverride or projectRuntime.
      const options = await spawnThroughProvider(
        automationSpawnRequest({ cwd: WINDOWS_CWD, worktreeId: `repo-1::${WINDOWS_CWD}` })
      )
      expect(pickKeys(options, SHELL_KEYS)).toEqual({
        shellOverride: 'powershell.exe',
        terminalWindowsWslDistro: null,
        terminalWindowsPowerShellImplementation: 'pwsh.exe'
      })
    })
  })
})
