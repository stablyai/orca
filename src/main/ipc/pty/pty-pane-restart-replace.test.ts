import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  installRestartHarness,
  leafId,
  registerWithFakes,
  restartSpawnArgs,
  tabId
} from './pty-pane-owner-swap.test-fixture'

const pacer = vi.hoisted(() => {
  const release = vi.fn()
  return { take: vi.fn<() => Promise<() => void>>(async () => release), release }
})
vi.mock('./ipc/user-resume-spawn-pacer', () => ({ userResumeSpawnPacer: pacer }))
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
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/configuration/homes/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/history/index/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('pty:spawn replacing a pane owner', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  beforeEach(() => {
    pacer.take.mockReset().mockResolvedValue(pacer.release)
    pacer.release.mockClear()
  })

  function exitPayloads(id: string): Record<string, unknown>[] {
    return mainWindow.webContents.send.mock.calls
      .filter(([channel, payload]) => channel === 'pty:exit' && payload?.id === id)
      .map(([, payload]) => payload)
  }

  function exitPayloads(id: string): Record<string, unknown>[] {
    return mainWindow.webContents.send.mock.calls
      .filter(([channel, payload]) => channel === 'pty:exit' && payload?.id === id)
      .map(([, payload]) => payload)
  }

  it("keeps a user-resume restart's old owner running until the pacer has a token", async () => {
    const { providerSpawn, shutdown, store, runtime } = installRestartHarness()
    registerWithFakes(mainWindow, runtime, store)
    let grant!: (release: () => void) => void
    pacer.take.mockImplementationOnce(() => new Promise<() => void>((resolve) => (grant = resolve)))

    const spawned = handlers.get('pty:spawn')!(null, {
      ...restartSpawnArgs({ replacesPtyId: 'pty-old' }),
      spawnIntent: 'user-resume'
    })
    await vi.waitFor(() => expect(pacer.take).toHaveBeenCalledTimes(1))
    expect(shutdown).not.toHaveBeenCalled()
    grant(pacer.release)

    await expect(spawned).resolves.toMatchObject({ id: 'pty-new' })
    expect(pacer.take).toHaveBeenCalledTimes(1)
    expect(pacer.release).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledWith('pty-old', expect.objectContaining({ immediate: true }))
    expect(providerSpawn.mock.calls.some(([options]) => !options.attachOnly)).toBe(true)
  })

  it('holds the reservation until the provider finishes starting the replacement', async () => {
    const { providerSpawn, store, runtime } = installRestartHarness()
    registerWithFakes(mainWindow, runtime, store)
    const spawn = providerSpawn.getMockImplementation()
    if (!spawn) {
      throw new Error('missing test provider')
    }
    let finishFork!: () => void
    const fork = new Promise<void>((resolve) => (finishFork = resolve))
    providerSpawn.mockImplementationOnce(async (options) => {
      await fork
      return spawn(options)
    })

    const pending = handlers.get('pty:spawn')!(null, {
      ...restartSpawnArgs({ replacesPtyId: 'pty-old' }),
      spawnIntent: 'user-resume'
    })
    try {
      await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledTimes(1))
      expect(pacer.release).not.toHaveBeenCalled()
    } finally {
      finishFork()
      await pending
    }

    await expect(pending).resolves.toMatchObject({ id: 'pty-new' })
    expect(pacer.release).toHaveBeenCalledTimes(1)
  })

  it('releases the reservation when the replacement fails', async () => {
    const { providerSpawn, store, runtime } = installRestartHarness()
    registerWithFakes(mainWindow, runtime, store)
    providerSpawn.mockRejectedValueOnce(new Error('spawn failed'))

    await expect(
      handlers.get('pty:spawn')!(null, {
        ...restartSpawnArgs({ replacesPtyId: 'pty-old' }),
        spawnIntent: 'user-resume'
      })
    ).rejects.toThrow('spawn failed')
    expect(pacer.release).toHaveBeenCalledTimes(1)
  })

  it('refuses an old restart after another owner has already claimed the pane', async () => {
    const { shutdown, providerSpawn, store, runtime } = installRestartHarness()
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId] = 'successor'
    registerWithFakes(mainWindow, runtime, store)
    await expect(
      handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))
    ).rejects.toThrow('terminal_pane_owner_changed')
    expect(shutdown).not.toHaveBeenCalled()
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
  })
})
