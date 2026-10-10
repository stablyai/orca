import { existsSync, readFileSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { getRuntimeEnvironmentSidecarPath } from '../../shared/runtime-environment-sidecar'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { orcadMigrationCutoverFixture } from './orcad-migration-cutover-fixture'
import {
  createManagedLifecycleHarness,
  MANAGED_VERSION
} from './orcad-managed-lifecycle-test-fixture'

const mocks = vi.hoisted(() => {
  const state: { store: unknown; transaction: unknown } = { store: null, transaction: null }
  return {
    state,
    resolveContext: vi.fn(),
    census: vi.fn(),
    decommission: vi.fn(),
    recover: vi.fn(),
    cancel: vi.fn(),
    keepServing: vi.fn(),
    closeTunnel: vi.fn(),
    ensureTunnel: vi.fn(),
    retire: vi.fn()
  }
})

vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ connect: async () => ({}) }),
  getSshTargetRegistryStore: () => mocks.state.store
}))
vi.mock('./orcad-remote-context', () => ({ resolveOrcadRemoteContext: mocks.resolveContext }))
vi.mock('./orcad-terminal-census-client', () => ({ collectManagedTerminalCensus: mocks.census }))
vi.mock('./orcad-remote-decommission', () => ({ decommissionRemoteOrcad: mocks.decommission }))
vi.mock('./orcad-activation-recovery', () => ({ recoverInterruptedOrcadActivation: mocks.recover }))
vi.mock('./orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: async () => mocks.state.transaction
}))
vi.mock('./orcad-activation-lock', () => ({
  withStaleOrcadActivationRecoveryLock: async (
    _options: unknown,
    run: (lock: { retain: () => void }) => Promise<unknown>
  ) => run({ retain: () => {} })
}))
vi.mock('./orcad-managed-remote-stop', () => ({ cancelRemoteOrcadManagedStop: mocks.cancel }))
vi.mock('./orcad-decommission-recovery', () => ({ reconcileOrcadDecommission: mocks.keepServing }))
vi.mock('./orcad-managed-tunnel', () => ({
  closeOrcadManagedTunnel: mocks.closeTunnel,
  ensureOrcadManagedTunnel: mocks.ensureTunnel
}))

const { cancelManagedOrcadStop, stopManagedOrcadEnvironment } =
  await import('./orcad-runtime-lifecycle')

const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 7 }
let harness: ReturnType<typeof createManagedLifecycleHarness>

const stop = (isActive = false) =>
  stopManagedOrcadEnvironment(
    harness.userDataPath,
    { selector: 'Managed' },
    { isActiveEnvironment: () => isActive, retireLocalState: mocks.retire }
  )

function expectStillLinked(): void {
  expect(listEnvironments(harness.userDataPath)[0]?.orcadDeployment).toBeDefined()
  expect(getManagedOrcadFenceEnvironmentId(harness.current())).toBe('environment-1')
  expect(mocks.retire).not.toHaveBeenCalled()
  expect(mocks.closeTunnel).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.resetAllMocks()
  harness = createManagedLifecycleHarness()
  mocks.state.store = harness.targetStore
  mocks.state.transaction = null
  mocks.resolveContext.mockImplementation(async () => harness.context())
  mocks.census.mockResolvedValue(idle)
})

afterEach(() => rmSync(harness.userDataPath, { recursive: true, force: true }))

describe('stopManagedOrcadEnvironment', () => {
  it('unlinks the server only after the host proves orcad exited', async () => {
    writeOrcadMigrationSourceCutover(harness.userDataPath, {
      ...orcadMigrationCutoverFixture('migration-1', 'ssh-1', { environmentId: 'environment-1' }),
      phase: 'destination-committed',
      sourceRetainedAt: '2026-10-01T00:00:00.000Z'
    })
    mocks.decommission.mockResolvedValueOnce({
      outcome: 'decommissioned',
      version: MANAGED_VERSION,
      retirement: 'retired'
    })
    await expect(stop()).resolves.toEqual({
      outcome: 'unlinked',
      verdict: 'exited',
      environmentId: 'environment-1',
      sshTargetId: 'ssh-1',
      stoppedVersion: MANAGED_VERSION,
      retirement: 'retired'
    })
    expect(mocks.decommission.mock.calls[0]?.[0]).toMatchObject({ census: idle, port: 6_768 })
    expect(listEnvironments(harness.userDataPath)).toEqual([])
    expect(
      readFileSync(getRuntimeEnvironmentSidecarPath(harness.userDataPath), 'utf8')
    ).not.toContain('orcadDeployment')
    expect(harness.current().orcadFence).toBeUndefined()
    expect(harness.flushes).toHaveLength(1)
    expect(mocks.retire).toHaveBeenCalledWith('environment-1')
    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
    // Its retained journal would otherwise block every later conversion of the host.
    expect(listOrcadMigrationSourceCutovers(harness.userDataPath)).toEqual([])
  })

  it.each([
    ['live', 'orcad_decommission_terminals_running'],
    ['unverifiable', 'orcad_decommission_census_unavailable'],
    ['unverifiable', 'orcad_decommission_stop_unsettled']
  ] as const)('keeps every link when the verdict is %s (%s)', async (verdict, code) => {
    mocks.decommission.mockResolvedValueOnce({ outcome: 'refused', verdict, code, reason: 'no' })
    await expect(stop()).resolves.toMatchObject({ outcome: 'refused', verdict, code })
    expectStillLinked()
    expect(existsSync(getRuntimeEnvironmentSidecarPath(harness.userDataPath))).toBe(true)
  })

  it('refuses the Active Server before contacting the host', async () => {
    await expect(stop(true)).resolves.toMatchObject({ code: 'orcad_stop_active_environment' })
    expect(mocks.resolveContext).not.toHaveBeenCalled()
    expectStillLinked()
  })

  it('finishes an interrupted stop from its journal and unlinks only on proven exit', async () => {
    mocks.state.transaction = { operation: 'decommission', activeVersion: MANAGED_VERSION }
    mocks.recover.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_recovery_decommission_unsettled',
      reason: 'no answer'
    })
    await expect(stop()).resolves.toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    expectStillLinked()
    mocks.recover.mockResolvedValueOnce({
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: null,
      readiness: null
    })
    await expect(stop()).resolves.toMatchObject({ outcome: 'unlinked', verdict: 'exited' })
    expect(mocks.decommission).not.toHaveBeenCalled()
  })

  it('starts over, never reading live, when another run settled the journal first', async () => {
    mocks.state.transaction = { operation: 'decommission', activeVersion: MANAGED_VERSION }
    mocks.recover.mockImplementationOnce(async () => {
      mocks.state.transaction = null
      return { outcome: 'none' }
    })
    mocks.decommission.mockResolvedValueOnce({
      outcome: 'decommissioned',
      version: MANAGED_VERSION,
      retirement: null
    })
    await expect(stop()).resolves.toMatchObject({ outcome: 'unlinked', verdict: 'exited' })

    rmSync(harness.userDataPath, { recursive: true, force: true })
    harness = createManagedLifecycleHarness()
    mocks.state.store = harness.targetStore
    mocks.state.transaction = { operation: 'decommission', activeVersion: MANAGED_VERSION }
    mocks.recover.mockResolvedValue({ outcome: 'none' })
    await expect(stop()).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_stop_journal_changed'
    })
  })

  it('refuses while another interrupted operation holds the journal', async () => {
    mocks.state.transaction = { operation: 'activate' }
    await expect(stop()).resolves.toMatchObject({ code: 'orcad_activation_recovery_required' })
    expectStillLinked()
  })

  it('unlinks a server whose record already shows nothing active', async () => {
    mocks.resolveContext.mockImplementation(async () => harness.context({ active: null }))
    await expect(stop()).resolves.toMatchObject({ outcome: 'unlinked', stoppedVersion: null })
    expect(mocks.decommission).not.toHaveBeenCalled()
  })
})

describe('cancelManagedOrcadStop', () => {
  const request = { transactionId: 't-1', version: MANAGED_VERSION }
  const cancel = () => cancelManagedOrcadStop(harness.userDataPath, { selector: 'Managed' })

  it('has nothing to cancel without a decommission journal', async () => {
    await expect(cancel()).resolves.toEqual({ outcome: 'none' })
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('withdraws a stop orcad never acted on and keeps the server serving', async () => {
    mocks.state.transaction = {
      operation: 'decommission',
      phase: 'stop-dispatched',
      activeVersion: MANAGED_VERSION,
      request
    }
    mocks.cancel.mockResolvedValueOnce({ outcome: 'canceled' })
    mocks.keepServing.mockResolvedValueOnce({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: MANAGED_VERSION,
      readiness: null
    })
    await expect(cancel()).resolves.toEqual({ outcome: 'canceled', activeVersion: MANAGED_VERSION })
    expect(mocks.keepServing.mock.calls[0]?.[1]).toEqual({
      action: 'keep-serving',
      version: MANAGED_VERSION
    })
    expect(mocks.ensureTunnel).toHaveBeenCalledOnce()
    expectStillLinked()
  })

  it('refuses once orcad already acted on the stop', async () => {
    mocks.state.transaction = {
      operation: 'decommission',
      phase: 'stop-dispatched',
      activeVersion: MANAGED_VERSION,
      request
    }
    mocks.cancel.mockResolvedValueOnce({ outcome: 'dispatched' })
    await expect(cancel()).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_stop_already_dispatched'
    })
    expect(mocks.keepServing).not.toHaveBeenCalled()
  })

  it('reports an already-exited stop for stop to finish', async () => {
    mocks.state.transaction = {
      operation: 'decommission',
      phase: 'process-exited',
      activeVersion: MANAGED_VERSION,
      request
    }
    await expect(cancel()).resolves.toEqual({ outcome: 'already-stopped' })
    expectStillLinked()
  })
})
