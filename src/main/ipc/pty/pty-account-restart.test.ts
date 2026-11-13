import { agentSessionOwners } from './pane/agent-session-owners'
import { accountRestartErrorReceipt } from './pane/account-restart-owner'
import { terminalStartError } from '../../../shared/terminal/pty/lifecycle/terminal-start-failure'
import { mapRuntimeError } from '../../runtime/rpc/responses/rpc-response'
import {
  readAccountRestartReceipt,
  type AccountRestartCondition
} from '../../../shared/terminal/pty/lifecycle/account-restart-contract'
import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  installRestartHarness,
  leafId,
  registerWithFakes,
  restartSpawnArgs,
  tabId,
  worktreeId,
  paneKey
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

function condition(): AccountRestartCondition {
  return {
    requestId: 'account-request',
    attemptId: 'account-attempt',
    hostEpoch: 'test-host',
    pane: { worktreeId, tabId, leafId, tabCreatedAt: 1 },
    expected: { kind: 'endpoint', ptyId: 'pty-old', incarnationId: 'inc-old', bindingGeneration: 1 }
  }
}

describe('conditional Codex account restart at the IPC boundary', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  const invoke = async (accountRestart = condition()) =>
    handlers.get('pty:spawn')!(null, restartSpawnArgs({ accountRestart }))

  it('replaces the exact old endpoint and commits its successor', async () => {
    const h = installRestartHarness()
    h.store.trackPtyBindingGeneration({ hostId: 'local', leafId })
    registerWithFakes(mainWindow, h.runtime, h.store)
    await expect(invoke()).resolves.toMatchObject({ id: 'pty-new' })
    expect(h.leafBinding()).toBe('pty-new')
    expect(h.shutdown).toHaveBeenCalledTimes(1)
  })

  it('refuses same-ID/new-incarnation ownership before stopping anything', async () => {
    const h = installRestartHarness()
    h.store.trackPtyBindingGeneration({ hostId: 'local', leafId })
    h.store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey[paneKey] = 'inc-successor'
    registerWithFakes(mainWindow, h.runtime, h.store)
    await expect(invoke()).rejects.toThrow('terminal_pane_owner_changed')
    expect(h.shutdown).not.toHaveBeenCalled()
    expect(h.providerSpawn).not.toHaveBeenCalled()
    expect(h.leafBinding()).toBe('pty-old')
  })

  it('preserves the human diagnostic and unknown stop evidence on pre-stop failure', async () => {
    const h = installRestartHarness({ shutdownFails: true })
    h.store.trackPtyBindingGeneration({ hostId: 'local', leafId })
    registerWithFakes(mainWindow, h.runtime, h.store)
    const error = await invoke().catch((e: unknown) => e)
    expect(String(error)).toContain('daemon unreachable')
    expect(readAccountRestartReceipt(error)).toMatchObject({
      stop: 'unknown',
      requestId: 'account-request',
      attemptId: 'account-attempt'
    })
    expect(h.providerSpawn).not.toHaveBeenCalled()
    expect(h.leafBinding()).toBe('pty-old')
  })

  it('keeps an empty existing leaf after post-stop failure and retries there without a PTY', async () => {
    const h = installRestartHarness()
    h.store.trackPtyBindingGeneration({ hostId: 'local', leafId })
    h.providerSpawn.mockRejectedValueOnce(new Error('launch refused'))
    registerWithFakes(mainWindow, h.runtime, h.store)
    const error = await invoke().catch((e: unknown) => e)
    const receipt = readAccountRestartReceipt(error)
    expect(receipt).toMatchObject({
      stop: 'confirmed-retired',
      current: { kind: 'empty', bindingGeneration: 2 }
    })
    expect(h.leafBinding()).toBeUndefined()
    expect(h.store.getWorkspaceSession().terminalLayoutsByTabId[tabId].root).toEqual({
      type: 'leaf',
      leafId
    })
    await expect(
      invoke({
        ...condition(),
        attemptId: 'retry',
        expected: { kind: 'empty', bindingGeneration: 2 }
      })
    ).resolves.toMatchObject({ id: 'pty-new' })
    expect(h.shutdown).toHaveBeenCalledTimes(1)
    expect(h.leafBinding()).toBe('pty-new')
  })

  it('does not dispatch or clear a successor installed during stop', async () => {
    const stopped = Promise.withResolvers<void>()
    const h = installRestartHarness({ shutdownGate: stopped.promise })
    h.store.trackPtyBindingGeneration({ hostId: 'local', leafId })
    registerWithFakes(mainWindow, h.runtime, h.store)
    const pending = invoke().catch((e: unknown) => e)
    await vi.waitFor(() => expect(h.shutdown).toHaveBeenCalledTimes(1))
    h.store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId] = 'successor'
    h.store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey[paneKey] = 'inc-successor'
    stopped.resolve()
    expect(String(await pending)).toContain('terminal_pane_owner_changed')
    expect(h.providerSpawn).not.toHaveBeenCalled()
    expect(h.leafBinding()).toBe('successor')
  })
  it('enforces the same condition on runtime creation and empty-leaf Retry', async () => {
    const h = installRestartHarness()
    h.store.trackPtyBindingGeneration({ hostId: 'local', leafId })
    registerWithFakes(mainWindow, h.runtime, h.store)
    const controller = h.runtime.setPtyController.mock.lastCall?.[0]
    if (!controller?.spawn) {
      throw new Error('runtime controller not installed')
    }
    const args = {
      ...restartSpawnArgs(),
      launchAgent: 'codex' as const,
      commandDelivery: 'provider' as const,
      persistHostSessionBinding: true,
      accountRestart: condition(),
      spawnIntent: 'user-resume' as const
    }
    h.providerSpawn.mockRejectedValueOnce(new Error('launch refused'))
    const failure = await controller.spawn(args).catch((error: unknown) => error)
    expect(accountRestartErrorReceipt(failure)).toMatchObject({
      stop: 'confirmed-retired',
      outcome: 'terminal',
      current: { kind: 'empty', bindingGeneration: 2 }
    })
    expect(h.leafBinding()).toBeUndefined()
    await expect(
      controller.spawn({
        ...args,
        accountRestart: {
          ...condition(),
          attemptId: 'runtime-retry',
          expected: { kind: 'empty', bindingGeneration: 2 }
        }
      })
    ).resolves.toMatchObject({ id: 'pty-new' })
    expect(h.leafBinding()).toBe('pty-new')
  })

  it('refuses a late binding commit over a successor and preserves that successor', async () => {
    const h = installRestartHarness()
    h.store.trackPtyBindingGeneration({ hostId: 'local', leafId })
    h.providerSpawn.mockImplementationOnce(async () => {
      h.store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId] =
        'successor'
      h.store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey[paneKey] = 'inc-successor'
      return { id: 'pty-new', incarnationId: 'inc-new' }
    })
    registerWithFakes(mainWindow, h.runtime, h.store)
    await expect(invoke()).rejects.toThrow('terminal_pane_owner_changed')
    expect(h.leafBinding()).toBe('successor')
  })
  it('preserves the Windows capacity diagnostic and stop proof through the final IPC formatter', async () => {
    const h = installRestartHarness()
    h.store.trackPtyBindingGeneration({ hostId: 'local', leafId })
    h.providerSpawn.mockRejectedValueOnce(
      terminalStartError(
        'provider stopped',
        { kind: 'exited', exitCode: 1, initialOutputDiagnostic: 'git-bash-console-capacity' },
        'inc-new'
      )
    )
    registerWithFakes(mainWindow, h.runtime, h.store)
    const error = await invoke().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error && error.message).toContain('128 open terminals')
    expect(readAccountRestartReceipt(error)).toMatchObject({
      requestId: 'account-request',
      attemptId: 'account-attempt',
      stop: 'confirmed-retired',
      outcome: 'terminal',
      current: { kind: 'empty', bindingGeneration: 2 }
    })
  })

  it('preserves the same proof in the RPC error data after Windows formatting', async () => {
    const h = installRestartHarness()
    h.store.trackPtyBindingGeneration({ hostId: 'local', leafId })
    h.providerSpawn.mockRejectedValueOnce(
      terminalStartError(
        'provider stopped',
        { kind: 'exited', exitCode: 1, initialOutputDiagnostic: 'git-bash-console-capacity' },
        'inc-new'
      )
    )
    registerWithFakes(mainWindow, h.runtime, h.store)
    const controller = h.runtime.setPtyController.mock.lastCall?.[0]
    if (!controller?.spawn) {
      throw new Error('runtime controller not installed')
    }
    const error = await controller
      .spawn({
        ...restartSpawnArgs(),
        accountRestart: condition(),
        launchAgent: 'codex',
        commandDelivery: 'provider',
        persistHostSessionBinding: true,
        spawnIntent: 'user-resume'
      })
      .catch((failure: unknown) => failure)
    const response = mapRuntimeError('rpc-create', { runtimeId: 'runtime-local' }, error)
    expect(response.error.code).toBe('runtime_error')
    expect(response.error.message).toContain('128 open terminals')
    expect(readAccountRestartReceipt({ response })).toMatchObject({
      requestId: 'account-request',
      attemptId: 'account-attempt',
      stop: 'confirmed-retired',
      outcome: 'terminal',
      current: { kind: 'empty', bindingGeneration: 2 }
    })
  })
  it('refuses an ensure adoption from another provider-session owner without touching that owner', async () => {
    const h = installRestartHarness()
    h.store.trackPtyBindingGeneration({ hostId: 'local', leafId })
    registerWithFakes(mainWindow, h.runtime, h.store)
    const controller = h.runtime.setPtyController.mock.lastCall?.[0]
    if (!controller?.spawn) {
      throw new Error('runtime controller not installed')
    }
    const claim = {
      digestVersion: 1 as const,
      keyId: 'f2-key',
      identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      agent: 'codex' as const
    }
    agentSessionOwners.register({
      claim,
      ptyId: 'provider-owner-elsewhere',
      phase: 'live',
      generation: 'foreign-generation',
      surface: {
        worktreeId,
        tabId: 'another-tab',
        leafId: '00000000-0000-4000-8000-000000000003',
        terminalHandle: 'foreign-handle'
      }
    })
    try {
      await expect(
        controller.spawn({
          ...restartSpawnArgs(),
          accountRestart: condition(),
          launchAgent: 'codex',
          commandDelivery: 'provider',
          persistHostSessionBinding: true,
          spawnIntent: 'user-resume',
          agentSessionEnsure: {
            claim,
            surface: { worktreeId, tabId, leafId, terminalHandle: 'requested-handle' }
          }
        })
      ).rejects.toThrow('agent_session_conflict')
      expect(h.providerSpawn).not.toHaveBeenCalled()
      expect(h.leafBinding()).toBeUndefined()
    } finally {
      agentSessionOwners.release('provider-owner-elsewhere', 'foreign-generation')
    }
  })
})
