import { PreparedPaneReplacement } from '../../runtime/terminal/recovery/prepared-pane-replacement'
import { reservePaneSpawn, makePaneSpawnReservationKey } from './pane/spawn-reservation'
import { cwd, worktreeId, paneKey } from './pty-pane-owner-swap.test-fixture'
import { BareWorkspaceTerminalLaunchError } from '../../workspaces/catalog/workspace-git-storage'
import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { WorktreeTerminalMutationLock } from '../../runtime/workspaces/lifecycle/worktree-terminal-mutation-lock'
import {
  installRestartHarness,
  leafId,
  registerWithFakes,
  restartSpawnArgs,
  tabId
} from './pty-pane-owner-swap.test-fixture'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/status-hooks/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server/agent-hook-server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/managed-extensions/titlebar-extension-service', () =>
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
vi.mock('../../cli/launchers/linux-terminal-orca-cli-shim', () =>
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

describe('pty:spawn replacing a pane owner', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

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
  it('refuses fresh replacement admission before stopping or retiring the original terminal', async () => {
    const { shutdown, providerSpawn, store, runtime } = installRestartHarness()
    const refused = new BareWorkspaceTerminalLaunchError()
    const qualifiedRuntime = Object.assign(runtime, {
      acquireWorktreeTerminalSpawn: async () => {
        throw refused
      }
    })
    registerWithFakes(mainWindow, qualifiedRuntime, store)
    await expect(
      handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))
    ).rejects.toThrow(refused.message)
    expect(shutdown).not.toHaveBeenCalled()
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]).toBe(
      'pty-old'
    )
    expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey[`${tabId}:${leafId}`]).toBe(
      'inc-old'
    )
  })

  it('finishes a checkout replacement before an already queued exclusive workspace action', async () => {
    const { providerSpawn, store, runtime } = installRestartHarness()
    const lock = new WorktreeTerminalMutationLock()
    const order: string[] = []
    let exclusive: Promise<void> | undefined
    const qualifiedRuntime = Object.assign(runtime, {
      acquireWorktreeTerminalSpawn: async () => {
        const release = await lock.acquire('checkout-restart', 'shared')
        exclusive = lock.acquire('checkout-restart', 'exclusive').then((done) => {
          order.push('exclusive')
          done()
        })
        return release
      }
    })
    const spawn = providerSpawn.getMockImplementation()!
    providerSpawn.mockImplementation(async (args) => {
      if (!args.attachOnly) {
        order.push('replacement')
      }
      return spawn(args)
    })
    registerWithFakes(mainWindow, qualifiedRuntime, store)
    await expect(
      handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))
    ).resolves.toMatchObject({ id: 'pty-new' })
    await exclusive
    expect(order).toEqual(['replacement', 'exclusive'])
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]).toBe(
      'pty-new'
    )
  })

  it('admits runtime creates only after policy and transfers a prepared replacement lease through commit', async () => {
    const { providerSpawn, store, runtime } = installRestartHarness()
    const refused = new BareWorkspaceTerminalLaunchError()
    const acquire = vi.fn(async () => {
      throw refused
    })
    const qualifiedRuntime = Object.assign(runtime, { acquireWorktreeTerminalSpawn: acquire })
    registerWithFakes(mainWindow, qualifiedRuntime, store)
    const controller = runtime.setPtyController.mock.calls.at(-1)![0]
    const admitTerminalPane = vi.fn(async () => {})
    const request = {
      cols: 80,
      rows: 24,
      cwd,
      worktreeId,
      tabId,
      leafId,
      preAllocatedHandle: 'term-runtime-replacement',
      persistHostSessionBinding: true,
      paneSpawnOperation: { mustExist: false },
      admitPreparedSpawn: admitTerminalPane
    }
    await expect(controller.spawn!(request)).rejects.toBe(refused)
    expect(admitTerminalPane).not.toHaveBeenCalled()
    expect(providerSpawn).not.toHaveBeenCalled()

    // The layout replacement producer retired this exact binding before handing the prepared start off.
    delete store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
    delete store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey[paneKey]
    const key = makePaneSpawnReservationKey(worktreeId, null, paneKey)!
    const reservation = reservePaneSpawn(key)
    const release = vi.fn(() => {
      expect(store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]).toBe(
        'pty-new'
      )
    })
    const replacement = new PreparedPaneReplacement(
      { id: worktreeId, path: cwd, connectionId: null, repo: null, folderWorkspace: null },
      tabId,
      leafId,
      'pty-old',
      key,
      reservation,
      {
        cwd,
        requestedCwd: cwd,
        terminalRuntimeOptions: { shellOverride: undefined, terminalWindowsWslDistro: null },
        expectedWslDistro: null,
        codexSelectionTarget: { runtime: 'host' }
      },
      { resumeStartup: undefined, agentStartup: {} },
      release
    )
    const spawn = providerSpawn.getMockImplementation()!
    providerSpawn.mockImplementation(async (args) => {
      expect(admitTerminalPane).toHaveBeenCalledOnce()
      expect(release).not.toHaveBeenCalled()
      return spawn(args)
    })
    await expect(
      controller.spawn!({ ...request, preparedReplacement: replacement })
    ).resolves.toMatchObject({ id: 'pty-new' })
    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]).toBe(
      'pty-new'
    )
    expect(release).toHaveBeenCalledOnce()
    replacement.releaseUnused()
    expect(release).toHaveBeenCalledOnce()
  })
})
