import { beforeEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { setAppEnvironment } from '../../shared/app-environment'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'
import { createAdapter } from '../daemon/daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { installDaemonProvider, replaceDaemonProvider } from '../daemon/daemon-provider-state'
import type { DaemonIdleRetirementResult } from '../daemon/daemon-pty-runtime-state'
import { PROTOCOL_VERSION } from '../daemon/types'
import { getLocalPtyProvider } from '../ipc/pty/provider/registry'
import { restartDaemon } from '../daemon/daemon-provider-restart'
import { bindOrcadIdleShutdown, beginOrcadIdleExit } from './orcad-managed-idle-exit-host'
import { installOrcadManagedIdleExit } from './orcad-managed-idle-exit'
import type * as ManagedIdleExit from './orcad-managed-idle-exit'

const { hasLoadedProviders } = vi.hoisted(() => ({ hasLoadedProviders: vi.fn(() => false) }))

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ hasLoadedProviders })
}))
vi.mock('../daemon/daemon-provider-restart', () => ({ restartDaemon: vi.fn() }))
vi.mock('./orcad-idle-stop-record', () => ({
  consumeOrcadIdleStopRecord: vi.fn(() => null),
  discardOrcadIdleStopRecord: vi.fn(),
  writeOrcadIdleStopRecord: vi.fn()
}))
vi.mock('./orcad-managed-idle-exit', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedIdleExit>()),
  installOrcadManagedIdleExit: vi.fn(() => () => {})
}))

function freshRouter(retirements: Promise<DaemonIdleRetirementResult>[] = []): DaemonPtyRouter {
  const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
  let fenced = false
  let fenceHeld = false
  const spawn = current.spawn
  current.spawn = vi.fn(async (opts) => {
    if (fenced) {
      throw new Error('Terminal daemon is decommissioning')
    }
    return spawn(opts)
  })
  vi.mocked(current.isIdleRetirementAdmissionClosed).mockImplementation(() => fenced)
  vi.mocked(current.requestIdleRetirement).mockImplementation(async () => {
    fenced = true
    const result = await (retirements.shift() ?? { state: 'retiring' as const })
    // A lost reply may hide accepted retirement, so keep admission fenced.
    fenceHeld = result.state === 'retiring' || result.state === 'unverifiable'
    fenced = fenceHeld
    return result
  })
  vi.mocked(current.releaseIdleRetirementFence).mockImplementation(() => {
    fenced = fenceHeld
  })
  return new DaemonPtyRouter({ current, legacy: [] })
}

async function stopWithReturningClient(
  retirementState: DaemonIdleRetirementResult,
  options: { automationsBusy?: boolean; retry?: DaemonIdleRetirementResult } = {}
) {
  const retire = Promise.withResolvers<DaemonIdleRetirementResult>()
  installDaemonProvider(
    null,
    freshRouter([retire.promise, ...(options.retry ? [Promise.resolve(options.retry)] : [])])
  )
  const activity = { openConnections: 0, requestsInFlight: 0, lastRequestAt: 0 }
  let automationsBusy = false
  const shutdown = vi.fn(() => true)
  bindOrcadIdleShutdown(shutdown)
  await beginOrcadIdleExit('test-profile').start({
    rpc: { readClientActivity: () => activity },
    agentStates: () => [],
    hasStagedMigration: () => false,
    automationsBusy: () => automationsBusy,
    emulatorsBusy: async () => false,
    registerCleanup: () => {}
  })
  const installed = vi.mocked(installOrcadManagedIdleExit).mock.calls.at(-1)?.[0]
  if (!installed) {
    throw new Error('idle monitor was not installed')
  }
  const stopping = installed.stop({ quietSince: 0, stoppedAt: 900_000, timeoutMs: 900_000 })
  await vi.waitFor(() =>
    expect(getLocalPtyProvider().spawn({ cols: 80, rows: 24 })).rejects.toThrow('decommissioning')
  )
  activity.openConnections = 1
  automationsBusy = options.automationsBusy ?? false
  retire.resolve(retirementState)
  return { stopped: await stopping, shutdown }
}

beforeEach(() => {
  vi.clearAllMocks()
  hasLoadedProviders.mockReturnValue(false)
  vi.stubEnv(ORCAD_MANAGED_ACTIVATION_ROOT_ENV, 'test-fence')
  setAppEnvironment({
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  vi.mocked(restartDaemon).mockImplementation(async () => {
    replaceDaemonProvider(freshRouter())
    return { killedCount: 0 }
  })
})

it('serves new terminals when a client returns after the daemon retired', async () => {
  const { stopped, shutdown } = await stopWithReturningClient({ state: 'retiring' })

  await expect(getLocalPtyProvider().spawn({ cols: 80, rows: 24 })).resolves.toEqual({
    id: 'current-new'
  })
  expect(stopped).toBe(false)
  expect(shutdown).not.toHaveBeenCalled()
  expect(restartDaemon).toHaveBeenCalledExactlyOnceWith({
    expectedDaemonPid: 4242,
    endpointMayBeGone: true
  })
})

it('finishes the stop when the retired daemon cannot be replaced', async () => {
  vi.mocked(restartDaemon).mockRejectedValueOnce(new Error('spawn failed'))
  const { stopped, shutdown } = await stopWithReturningClient({ state: 'retiring' })

  expect(stopped).toBe(true)
  expect(shutdown).toHaveBeenCalledWith('idle', expect.any(Function))
})

it('asks a daemon whose stop reply was lost again, and replaces it once it retires', async () => {
  const { stopped, shutdown } = await stopWithReturningClient(
    { state: 'unverifiable' },
    { retry: { state: 'retiring' } }
  )

  await expect(getLocalPtyProvider().spawn({ cols: 80, rows: 24 })).resolves.toEqual({
    id: 'current-new'
  })
  expect(stopped).toBe(false)
  expect(shutdown).not.toHaveBeenCalled()
  expect(restartDaemon).toHaveBeenCalledExactlyOnceWith({
    expectedDaemonPid: 4242,
    endpointMayBeGone: true
  })
})

it('keeps a daemon that refuses the second ask, and serves from it', async () => {
  const { stopped, shutdown } = await stopWithReturningClient(
    { state: 'unverifiable' },
    { retry: { state: 'busy', liveSessions: 1 } }
  )

  expect(restartDaemon).not.toHaveBeenCalled()
  expect(stopped).toBe(false)
  expect(shutdown).not.toHaveBeenCalled()
  await expect(getLocalPtyProvider().spawn({ cols: 80, rows: 24 })).resolves.toEqual({
    id: 'current-new'
  })
})

it('stays up for work the returning client started when the daemon cannot be replaced', async () => {
  vi.mocked(restartDaemon).mockRejectedValueOnce(new Error('spawn failed'))
  const { stopped, shutdown } = await stopWithReturningClient(
    { state: 'retiring' },
    { automationsBusy: true }
  )

  expect(stopped).toBe(false)
  expect(shutdown).not.toHaveBeenCalled()
})

it('never replaces a daemon that kept its admission open', async () => {
  const { stopped, shutdown } = await stopWithReturningClient({
    state: 'busy',
    liveSessions: 1,
    admissionReopened: true
  })

  expect(stopped).toBe(false)
  expect(shutdown).not.toHaveBeenCalled()
  expect(restartDaemon).not.toHaveBeenCalled()
  await expect(getLocalPtyProvider().spawn({ cols: 80, rows: 24 })).resolves.toEqual({
    id: 'current-new'
  })
})
