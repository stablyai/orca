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
import { createDaemonActiveProviderFixtures } from './pty-ipc-daemon-provider-fixtures'
import { _setWslCachesForTests } from '../../wsl'
import { registerPtyHandlers } from './register-handlers'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { parseWorkspaceSessionSalvaging } from '../../../shared/workspace-session-salvage'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import {
  addWorkspace,
  emptySession,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  const { makeProjectRuntimeStore } = createDaemonActiveProviderFixtures({ handlers, mainWindow })

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
      // Pin PowerShell probe roots so bare-name resolution is deterministic across test hosts (#5161).
      for (const key of ['SystemRoot', 'ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
        savedWindowsResolutionEnv[key] = process.env[key]
      }
      process.env.SystemRoot = 'C:\\Windows'
      process.env.ProgramW6432 = 'C:\\Program Files'
      process.env.ProgramFiles = 'C:\\Program Files'
      delete process.env['ProgramFiles(x86)']
      // Shell candidates need file/size evidence; directory probes must still report directories.
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

    it.each([
      { name: 'saved CMD host bypass', shell: 'cmd.exe', host: true, expectedHost: true },
      { name: 'old omitted choices', shell: undefined, host: undefined, expectedHost: undefined },
      { name: 'malformed optional choices', shell: 17, host: 'true', expectedHost: undefined }
    ])(
      'restores $name through disk validation into the actual spawn',
      async ({ shell, host, expectedHost }) => {
        const worktreeId = 'repo-1::C:\\repo'
        const session = addWorkspace(emptySession(), worktreeId, [
          {
            id: 'group-shell',
            tabs: [
              {
                id: 'tab-shell',
                leaves: [[leaf(1)]],
                row: { shellOverride: 'cmd.exe', forceHostRuntime: true }
              }
            ]
          }
        ])
        const context = { mintId: (seed: string) => seed, mintLeafId: () => leaf(2) }
        const stored = saveWorkspaceLayout(
          loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, context)
        )
        expect(stored.tabsByWorktree[worktreeId][0]).toMatchObject({
          shellOverride: 'cmd.exe',
          forceHostRuntime: true
        })
        const disk: unknown = JSON.parse(
          JSON.stringify({
            ...stored,
            tabsByWorktree: {
              [worktreeId]: stored.tabsByWorktree[worktreeId].map((row) => ({
                ...row,
                shellOverride: shell,
                forceHostRuntime: host
              }))
            }
          })
        )
        const parsed = parseWorkspaceSessionSalvaging(disk)
        if (!parsed.ok) {
          throw new Error(parsed.error)
        }
        expect(parsed.droppedCount).toBe(0)
        expect(parsed.value.tabsByWorktree[worktreeId]).toHaveLength(1)
        const restored = loadWorkspaceLayout(
          LOCAL_EXECUTION_HOST_ID,
          parsed.value,
          context
        ).layout.workspaces[worktreeId].tabs.find((tab) => tab.id === 'tab-shell')
        if (restored?.kind !== 'terminal') {
          throw new Error('Saved terminal was not restored')
        }

        _setWslCachesForTests({ available: true, distros: ['Ubuntu'] })
        const store = makeProjectRuntimeStore({
          projectRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        })
        vi.mocked(store.getWorkspaceSession).mockReturnValue(parsed.value)
        registerPtyHandlers(
          mainWindow,
          undefined,
          undefined,
          () =>
            createGlobalSettingsFixture({
              terminalWindowsShell: 'powershell.exe',
              terminalWindowsPowerShellImplementation: 'pwsh.exe'
            }),
          undefined,
          store
        )
        const result = await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          worktreeId,
          tabId: restored.entityId,
          shellOverride: restored.terminal.shellOverride
        })
        const expectedShell = expectedHost ? 'cmd.exe' : 'wsl.exe'
        const [spawnedShell, spawnArgs] = spawnMock.mock.calls.at(-1)!
        expect(spawnedShell).toBe(expectedShell)
        if (expectedHost) {
          expect(spawnArgs).toEqual(['/K', 'chcp 65001 > nul'])
        } else {
          expect(spawnArgs).toEqual(expect.arrayContaining(['-d', 'Ubuntu']))
        }
        expect(result).toMatchObject({
          shellPath: expectedShell,
          wslDistro: expectedHost ? null : 'Ubuntu'
        })
        expect(restored.terminal.shellOverride).toBe(expectedHost ? 'cmd.exe' : undefined)
        expect(restored.terminal.forceHostRuntime).toBe(expectedHost)
      }
    )

    it('uses terminalWindowsShell setting over COMSPEC when provided', async () => {
      // Stock COMSPEC selects cmd.exe; the saved shell preference must override it.
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
          createGlobalSettingsFixture({
            terminalWindowsShell: 'wsl.exe',
            terminalWindowsWslDistro: 'Debian'
          }),
        undefined,
        makeProjectRuntimeStore({ projectRuntimePreference: { kind: 'windows-host' } })
      )
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        worktreeId: 'repo-1::C:\\repo'
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
          createGlobalSettingsFixture({
            terminalWindowsShell: 'powershell.exe',
            terminalWindowsWslDistro: 'Debian'
          }),
        undefined,
        makeProjectRuntimeStore({
          projectRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        })
      )
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: 'C:\\Users\\test\\repo',
        worktreeId: 'repo-1::C:\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[1]).toEqual(expect.arrayContaining(['-d', 'Ubuntu']))
    })
    it('blocks terminal spawn when project runtime requires repair', async () => {
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      _setWslCachesForTests({ available: true, distros: ['Debian'] })

      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () =>
          createGlobalSettingsFixture({
            terminalWindowsShell: 'powershell.exe'
          }),
        undefined,
        makeProjectRuntimeStore({
          projectRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        })
      )

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          worktreeId: 'repo-1::C:\\repo'
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
