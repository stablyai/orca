import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSyncMock,
  statSyncMock,
  spawnMock,
  isPwshAvailableMock
} from './pty-ipc-mock-registry'
import {
  RESOLVED_WINDOWS_POWERSHELL,
  RESOLVED_PWSH7,
  POWERSHELL_OSC133_ARGS
} from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
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

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  describe('Windows UTF-8 code page', () => {
    let originalPlatform: string
    let originalComspec: string | undefined
    const savedWindowsResolutionEnv: Record<string, string | undefined> = {}

    beforeEach(() => {
      originalPlatform = process.platform
      originalComspec = process.env.COMSPEC
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      process.env.USERPROFILE = 'C:\\Users\\test'
      // Why: the spawn path resolves a bare PowerShell name to an absolute exe (PR #6537 / issue #5161); pin the probed install roots for deterministic resolution across host OS.
      for (const key of ['SystemRoot', 'ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
        savedWindowsResolutionEnv[key] = process.env[key]
      }
      process.env.SystemRoot = 'C:\\Windows'
      process.env.ProgramW6432 = 'C:\\Program Files'
      process.env.ProgramFiles = 'C:\\Program Files'
      delete process.env['ProgramFiles(x86)']
      // Why: .exe candidates must report isFile()/size (default mock omits them, collapsing every PowerShell candidate to cmd.exe); dirs must still report isDirectory().
      statSyncMock.mockImplementation((target: string) => {
        const isExe = /\.exe$/i.test(String(target))
        return {
          isDirectory: () => !isExe,
          isFile: () => isExe,
          size: isExe ? 1024 : 0,
          mode: 0o755
        }
      })
      existsSyncMock.mockReturnValue(true)
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalComspec === undefined) {
        delete process.env.COMSPEC
      } else {
        process.env.COMSPEC = originalComspec
      }
      for (const [key, value] of Object.entries(savedWindowsResolutionEnv)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      delete process.env.PYTHONUTF8
    })

    it('passes chcp 65001 to cmd.exe for UTF-8 console output', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Windows\\system32\\cmd.exe',
        ['/K', 'chcp 65001 > nul'],
        expect.any(Object)
      )
    })
    it('sets Console encoding for powershell.exe', async () => {
      process.env.COMSPEC = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })
    it('sets Console encoding for pwsh.exe', async () => {
      process.env.COMSPEC = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })
    it('sets PYTHONUTF8=1 in the spawn environment on Windows', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      const env = spawnCall[2].env as Record<string, string>
      expect(env.PYTHONUTF8).toBe('1')
    })
    it('does not override an existing PYTHONUTF8 value', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      process.env.PYTHONUTF8 = '0'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      const env = spawnCall[2].env as Record<string, string>
      expect(env.PYTHONUTF8).toBe('0')
    })
    it('launches Git Bash from COMSPEC as an interactive login shell', async () => {
      process.env.COMSPEC = 'C:\\Program Files\\Git\\bin\\bash.exe'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        ['-c', 'chcp.com 65001 >/dev/null 2>&1; exec "$BASH" --login -i'],
        expect.objectContaining({
          env: expect.objectContaining({ CHERE_INVOKING: '1' })
        })
      )
    })
    it('uses terminalWindowsShell setting over COMSPEC when provided', async () => {
      // Why: COMSPEC always points to cmd.exe on stock Windows, so without the setting the terminal would ignore the user's shell preference.
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        RESOLVED_WINDOWS_POWERSHELL,
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })
    it('uses the host shell when resolved project runtime overrides a stale WSL shell default', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'wsl.exe',
            terminalWindowsWslDistro: 'Debian'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'windows-host',
            hostPlatform: 'win32',
            projectId: 'repo-1',
            source: 'project-override',
            cacheKey: 'repo-1:windows-host'
          }
        }
      })

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Windows\\system32\\cmd.exe',
        ['/K', 'chcp 65001 > nul'],
        expect.any(Object)
      )
    })
    it('uses the selected project WSL distro when resolved runtime overrides the host shell default', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsWslDistro: 'Debian'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: 'C:\\Users\\test\\repo',
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'repo-1',
            distro: 'Ubuntu',
            source: 'project-override',
            cacheKey: 'repo-1:wsl:Ubuntu'
          }
        }
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[1]).toEqual(expect.arrayContaining(['-d', 'Ubuntu']))
    })
    it('blocks terminal spawn when project runtime requires repair', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe'
          }) as never
      )

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          projectRuntime: {
            status: 'repair-required',
            repair: {
              projectId: 'repo-1',
              reason: 'wsl-distro-missing',
              requestedDistro: 'Ubuntu',
              fallbackRuntime: null,
              cacheKey: 'repo-1:repair:wsl-distro-missing:Ubuntu'
            }
          }
        })
      ).rejects.toThrow('Project runtime requires repair before terminal spawn')
      expect(spawnMock).not.toHaveBeenCalled()
    })
    it('spawns powershell.exe when PowerShell family keeps the inbox implementation', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsPowerShellImplementation: 'powershell.exe'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        RESOLVED_WINDOWS_POWERSHELL,
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })
    it('spawns pwsh.exe when PowerShell 7 is selected and available', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      isPwshAvailableMock.mockReturnValue(true)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        RESOLVED_PWSH7,
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
    })
    it('keeps PowerShell 7 selected when the pwsh availability probe is cold-false', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      isPwshAvailableMock.mockReturnValue(false)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        RESOLVED_PWSH7,
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
      expect(isPwshAvailableMock).not.toHaveBeenCalled()
    })
    it('keeps a pwsh.exe shellOverride when the pwsh availability probe is cold-false', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      isPwshAvailableMock.mockReturnValue(false)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, shellOverride: 'pwsh.exe' })

      expect(spawnMock).toHaveBeenCalledWith(
        RESOLVED_PWSH7,
        POWERSHELL_OSC133_ARGS,
        expect.any(Object)
      )
      expect(isPwshAvailableMock).not.toHaveBeenCalled()
    })
    it('ignores the PowerShell implementation setting for cmd.exe', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\powershell.exe'
      isPwshAvailableMock.mockReturnValue(true)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          ({
            terminalWindowsShell: 'cmd.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      expect(spawnMock).toHaveBeenCalledWith(
        'cmd.exe',
        ['/K', 'chcp 65001 > nul'],
        expect.any(Object)
      )
    })
    it('ignores the PowerShell implementation setting for wsl.exe', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\powershell.exe'
      isPwshAvailableMock.mockReturnValue(true)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        () => 'C:\\Users\\test\\AppData\\Roaming\\Orca\\codex-runtime-home\\home',
        () =>
          ({
            terminalWindowsShell: 'wsl.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

      const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as { env: Record<string, string> }
      expect(spawnMock).toHaveBeenCalledWith('wsl.exe', expect.any(Array), expect.any(Object))
      expect(spawnOptions.env.CODEX_HOME).toBeUndefined()
      expect(spawnOptions.env.ORCA_CODEX_HOME).toBeUndefined()
    })
    it('keeps shellOverride priority for one-off tabs', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      isPwshAvailableMock.mockReturnValue(false)

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        () => 'C:\\Users\\test\\AppData\\Roaming\\Orca\\codex-runtime-home\\home',
        () =>
          ({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsPowerShellImplementation: 'pwsh.exe'
          }) as never
      )
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe'
      })

      const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as { env: Record<string, string> }
      expect(spawnMock).toHaveBeenCalledWith('wsl.exe', expect.any(Array), expect.any(Object))
      expect(spawnOptions.env.CODEX_HOME).toBeUndefined()
      expect(spawnOptions.env.ORCA_CODEX_HOME).toBeUndefined()
    })
  })
})
