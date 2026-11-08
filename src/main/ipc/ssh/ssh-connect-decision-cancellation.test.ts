import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../../ssh/config/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('../../ssh/connection/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../../ssh/connection/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../../ssh/port-forwarding/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)
vi.mock(import('../../ssh/legacy-relay/legacy-relay-bridge-registry'), async (importOriginal) => ({
  ...(await importOriginal()),
  startLegacyRelayBridge: vi.fn(async () => {}),
  stopLegacyRelayBridge: vi.fn()
}))

import type { SshManagedServerStatus, SshTarget } from '../../../shared/ssh-types'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { recordSshConnectionOpened } from '../../ssh/connection/ssh-connection-attribution'
import {
  decideHostServer,
  publishHostServerDecisionFailure,
  restoreKeptHostServer,
  publishManagedServerConnect,
  publishUnservedHostServer
} from './ssh-host-server-connect'
import { connectTarget } from './ssh-connect-flow'
import { connectInFlight } from './ssh-connect-attempt-registry'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority
} from '../../ssh/ssh-provider-authority'
import { clearSshHostServerStatus, setSshHostServerStatus } from '../../ssh/ssh-host-server-status'
import {
  startLegacyRelayBridge,
  stopLegacyRelayBridge
} from '../../ssh/legacy-relay/legacy-relay-bridge-registry'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager } = mocks

describe('a connect cancelled during its server decision', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers } = harness

  beforeEach(harness.reset)

  it('does not publish connected when the user disconnected during the legacy bridge wait', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const opened = { id: 'managed-transport' }
    vi.mocked(publishManagedServerConnect).mockClear()
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(undefined)
    mockConnectionManager.disconnect.mockResolvedValue(undefined)
    vi.mocked(decideHostServer).mockImplementationOnce(async () => {
      recordSshConnectionOpened(asTransport(opened))
      mockConnectionManager.getConnection.mockReturnValue(opened)
      return { route: 'managed', environmentId: 'env-1' }
    })
    vi.mocked(startLegacyRelayBridge).mockImplementationOnce(async () => {
      await handlers.get('ssh:disconnect')!(null, { targetId: 'ssh-1' })
    })
    await expect(
      Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' }))
    ).rejects.toThrow('SSH connection attempt was cancelled')
    expect(publishManagedServerConnect).not.toHaveBeenCalled()
    expect(stopLegacyRelayBridge).toHaveBeenCalledWith('ssh-1')
  })
})

describe('a quiet retry of a bridged host move (#29626)', () => {
  const harness = createSshIpcHarness(mocks)
  const target: SshTarget = {
    id: 'ssh-1',
    label: 'Server',
    host: 'example.com',
    port: 22,
    username: 'deploy'
  }
  const kept: SshManagedServerStatus = {
    kind: 'relay',
    reason: 'relay_terminals_live',
    terminals: 1,
    bridged: true
  }
  const elsewhere = {
    route: 'unserved',
    reason: 'relay_terminals_live',
    terminals: 1,
    terminalsElsewhere: true
  } as const

  beforeEach(async () => {
    await harness.reset()
    vi.clearAllMocks()
    mockSshStore.getTarget.mockReturnValue(target)
    // The kept session is reused, never opened by the retry.
    mockConnectionManager.getConnection.mockReturnValue({ id: 'kept-transport' })
    mockConnectionManager.getState.mockReturnValue({ targetId: 'ssh-1', status: 'connected' })
    setSshHostServerStatus('ssh-1', kept)
  })

  function expectHostKept(): void {
    expect(restoreKeptHostServer).toHaveBeenCalledWith('ssh-1')
    expect(publishUnservedHostServer).not.toHaveBeenCalled()
    expect(publishHostServerDecisionFailure).not.toHaveBeenCalled()
    expect(mockConnectionManager.disconnect).not.toHaveBeenCalled()
    expect(mockConnectionManager.disconnectConnection).not.toHaveBeenCalled()
    expect(stopLegacyRelayBridge).not.toHaveBeenCalled()
  }

  it('keeps the host and its authority when another terminal still refuses the move', async () => {
    const authority = { ...getSshProviderAuthority('ssh-1') }
    vi.mocked(decideHostServer).mockResolvedValueOnce(elsewhere)

    await expect(connectTarget('ssh-1', { quiet: true })).resolves.toMatchObject({
      status: 'connected'
    })
    expectHostKept()
    expect(getSshProviderAuthority('ssh-1')).toEqual(authority)
    expect(isCurrentSshProviderAuthority(authority)).toBe(true)
  })

  it('keeps the host and its authority when the retried decision throws', async () => {
    const generation = getSshProviderAuthority('ssh-1').connectionGeneration
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(decideHostServer).mockRejectedValueOnce(new Error('conversion failed'))

    await expect(connectTarget('ssh-1', { quiet: true })).resolves.toMatchObject({
      status: 'connected'
    })
    expectHostKept()
    expect(getSshProviderAuthority('ssh-1').connectionGeneration).toBe(generation)
  })

  it('shows no progress, then rotates authority and publishes once the move succeeds', async () => {
    const generation = getSshProviderAuthority('ssh-1').connectionGeneration
    let active: boolean | undefined
    vi.mocked(decideHostServer).mockImplementationOnce(async () => {
      // Progress reports only after the decision's first await, once the attempt is registered.
      await Promise.resolve()
      active = connectInFlight.get('ssh-1')?.quiet?.active
      return { route: 'managed', environmentId: 'env-1' }
    })

    await connectTarget('ssh-1', { quiet: true })

    expect(active).toBe(true)
    expect(getSshProviderAuthority('ssh-1').connectionGeneration).toBeGreaterThan(generation)
    expect(publishManagedServerConnect).toHaveBeenCalledWith(
      'ssh-1',
      'env-1',
      undefined,
      undefined,
      undefined,
      undefined
    )
    expect(restoreKeptHostServer).not.toHaveBeenCalled()
  })

  it('surfaces the refusal to a user connect that joined the retry', async () => {
    let decide = (): void => {}
    vi.mocked(decideHostServer).mockImplementationOnce(
      () => new Promise((resolve) => (decide = () => resolve(elsewhere)))
    )

    const retry = connectTarget('ssh-1', { quiet: true })
    await vi.waitFor(() => expect(connectInFlight.get('ssh-1')?.quiet?.active).toBe(true))
    const user = connectTarget('ssh-1')
    await vi.waitFor(() => expect(connectInFlight.get('ssh-1')?.quiet?.active).toBe(false))
    decide()

    await expect(user).rejects.toThrow('This SSH host isn’t supported')
    await expect(retry).rejects.toThrow('This SSH host isn’t supported')
    expect(publishUnservedHostServer).toHaveBeenCalledTimes(1)
    expect(restoreKeptHostServer).not.toHaveBeenCalled()
  })

  it('does nothing once the host is no longer kept for bridged terminals', async () => {
    clearSshHostServerStatus('ssh-1')

    await expect(connectTarget('ssh-1', { quiet: true })).rejects.toThrow(
      'SSH connection attempt was cancelled'
    )
    expect(decideHostServer).not.toHaveBeenCalled()
  })
})

type FakeTransport = { id: string }

function asTransport(value: FakeTransport): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution keys on identity only.
  return value as unknown as SshConnection
}
