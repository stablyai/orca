import { describe, expect, it, vi } from 'vitest'
import { onMock, spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './register-handlers'
import { bindSession } from '../../telemetry/protected-milestones'

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
vi.mock('../../agent-hooks/server/agent-hook-server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pty/shell-startup/pwsh', () =>
  import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../wsl/filesystem/unc-path-access', async (importOriginal) =>
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
vi.mock('../../agent-hooks/observations/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/configuration/homes/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/history/index/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const {
    handlers,
    mainWindow,
    mainWindowIpcEvent,
    foreignWindowIpcEvent,
    createMockProc,
    getPtyWriteListener
  } = setupPtyIpcSuite()

  it('admits a terminal user activity observation only from the main window', () => {
    const captured: string[] = []
    const settings = { telemetry: { protectedMilestones: { installCohort: 'existing' } } }
    const store = { getSettings: () => settings, updateSettings: () => undefined }
    bindSession(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies all store methods read by milestone capture.
      store as never,
      (name) => captured.push(name),
      () => true
    )
    registerPtyHandlers(mainWindow as never)
    const listener = onMock.mock.calls.find(([name]) => name === 'pty:noteUserInput')?.[1]
    if (!listener) {
      throw new Error('missing terminal user input listener')
    }

    listener(foreignWindowIpcEvent)
    expect(captured).toEqual([])
    listener(mainWindowIpcEvent)
    expect(captured).toEqual(['meaningful_activity_day'])
  })

  it('rejects malformed and cross-window pty write IPC before provider writes', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const write = getPtyWriteListener() as (event: unknown, args: unknown) => void
    const writeAccepted = handlers.get('pty:writeAccepted')! as (
      event: unknown,
      args: unknown
    ) => unknown

    write(mainWindowIpcEvent, null)
    write(mainWindowIpcEvent, { id: '', data: 'x' })
    write(mainWindowIpcEvent, { id: result.id, data: 1 })
    write(foreignWindowIpcEvent, { id: result.id, data: 'x' })

    expect(writeAccepted(mainWindowIpcEvent, null)).toBe(false)
    expect(writeAccepted(mainWindowIpcEvent, { id: '', data: 'x' })).toBe(false)
    expect(writeAccepted(mainWindowIpcEvent, { id: result.id, data: 1 })).toBe(false)
    expect(writeAccepted(foreignWindowIpcEvent, { id: result.id, data: 'x' })).toBe(false)
    expect(mockProc.proc.write).not.toHaveBeenCalled()
  })
})
