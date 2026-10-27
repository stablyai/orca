import { beforeEach, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../shared/runtime-environments'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), removeListener: vi.fn() } }))

const context = { isUpdate: false, shutdownDaemon: false }

beforeEach(() => {
  vi.resetModules()
})

it('rejects the first paired browser host after a pre-quit status request resolves late', async () => {
  const { runQuitTasks } = await import('./quit-task-registry')
  const runtime = await import('./browser/paired-runtime-browser-client-host-runtime')
  const { PairedRuntimeBrowserClientHostRegistry } =
    await import('./browser/paired-runtime-browser-client-host-registry')
  const start = vi.spyOn(PairedRuntimeBrowserClientHostRegistry.prototype, 'start')
  runtime.configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
  const environment: KnownRuntimeEnvironment = {
    id: 'environment-a',
    name: 'Environment A',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      {
        id: 'endpoint-a',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://runtime-a.test',
        deviceToken: 'token-a',
        publicKeyB64: 'key-a'
      }
    ],
    preferredEndpointId: 'endpoint-a'
  }
  const status = Promise.withResolvers<void>()
  const starting = status.promise.then(() =>
    runtime.startPairedRuntimeBrowserClientHost({ environment, authorityRuntimeId: 'runtime-a' })
  )
  try {
    await runQuitTasks('browser-client-hosts', context)
    status.resolve()
    await expect(starting).rejects.toThrow('paired_runtime_browser_client_host_registry_closed')
    expect(start).not.toHaveBeenCalled()
  } finally {
    start.mockRestore()
  }
})

it('leaves first-use Codex recovery and history bridging fenced after their quit phases', async () => {
  const { runQuitTasks } = await import('./quit-task-registry')
  await runQuitTasks('codex-backfill', context)
  await runQuitTasks('codex-bridges', context)
  const recovery = await import('./codex/codex-state-db-backfill-recovery')
  const bridge = await import('./codex/codex-account-session-bridge')
  const isPending = vi.fn(() => true)
  const run = vi.fn()
  const createStateDb = vi.fn()
  const healIndex = vi.fn()

  await expect(
    recovery.startCodexStateDbBackfillRecoveryInBackground('/unused-home', { isPending, run })
  ).resolves.toBeNull()
  await bridge.startCodexAccountSessionBridgeInBackground(
    { targetCodexHomePath: '/unused-home', sourceCodexHomePaths: ['/unused-source'] },
    { createStateDb, healIndex }
  )
  expect(bridge.isCodexAccountSessionBridgeStopping()).toBe(true)
  expect(isPending).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(createStateDb).not.toHaveBeenCalled()
  expect(healIndex).not.toHaveBeenCalled()
})

it('does not resolve a distro or launch a first WSL relay after relay teardown', async () => {
  const { runQuitTasks } = await import('./quit-task-registry')
  await runQuitTasks('wsl-relays', context)
  const { WslHookRelayManager } = await import('./agent-hooks/wsl-hook-relay-manager')
  const listDistros = vi.fn(async () => ['Ubuntu'])
  const spawnRelay = vi.fn()
  const manager = new WslHookRelayManager({
    platform: () => 'win32',
    remoteHooksEnabled: () => true,
    managedHookSettings: () => ({}),
    listDistros,
    spawnRelay
  })

  await manager.ensureForDistro(null)

  expect(listDistros).not.toHaveBeenCalled()
  expect(spawnRelay).not.toHaveBeenCalled()
})
