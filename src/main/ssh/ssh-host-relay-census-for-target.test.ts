import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import type { SshTarget } from '../../shared/ssh-types'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  getConnection: vi.fn(),
  disconnectConnection: vi.fn(async () => undefined),
  census: vi.fn()
}))
vi.mock('./orcad-managed-runtime-context', () => ({
  requireManagedOrcadInfrastructure: () => ({
    connectionManager: {
      connect: mocks.connect,
      getConnection: mocks.getConnection,
      disconnectConnection: mocks.disconnectConnection
    }
  })
}))
vi.mock('./ssh-host-relay-terminals-on-connect', () => ({
  censusSshHostRelaysBeforeSession: mocks.census,
  hostTerminalProofFromCensus: () => ({ verdict: 'exited', count: 0 })
}))

const { censusHostRelayTerminalsFor } = await import('./ssh-host-relay-census-for-target')
const attribution = await import('./ssh-connection-attribution')

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution keys on identity only.
const transport = (): SshConnection => ({}) as SshConnection

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a host census outside any connect', () => {
  it("holds the raw 'connected' while it runs and closes the transport it opened", async () => {
    const opened = transport()
    mocks.connect.mockImplementation(async () => {
      attribution.recordSshConnectionOpened(opened)
      mocks.getConnection.mockReturnValue(opened)
      return opened
    })
    mocks.census.mockImplementation(async () => {
      expect(attribution.isSshHostCensusInFlight('ssh-1')).toBe(true)
      return {}
    })
    await censusHostRelayTerminalsFor(target)()
    expect(attribution.isSshHostCensusInFlight('ssh-1')).toBe(false)
    expect(mocks.disconnectConnection).toHaveBeenCalledWith('ssh-1', opened)
  })

  it('leaves a transport a connect or tunnel adopted while it ran', async () => {
    const opened = transport()
    mocks.connect.mockImplementation(async () => {
      attribution.recordSshConnectionOpened(opened)
      mocks.getConnection.mockReturnValue(opened)
      return opened
    })
    mocks.census.mockImplementation(async () => {
      attribution.adoptSshConnection(opened, Symbol('connect'))
      return {}
    })
    await censusHostRelayTerminalsFor(target)()
    expect(mocks.disconnectConnection).not.toHaveBeenCalled()
  })

  it('leaves a transport it only reused', async () => {
    const existing = transport()
    mocks.getConnection.mockReturnValue(existing)
    mocks.connect.mockImplementation(async () => {
      attribution.recordSshConnectionReused(existing)
      return existing
    })
    mocks.census.mockResolvedValue({})
    await censusHostRelayTerminalsFor(target)()
    expect(mocks.disconnectConnection).not.toHaveBeenCalled()
  })

  it("inside a connect's decision leaves the transport to that connect", async () => {
    const opened = transport()
    const decision = Symbol('decision')
    mocks.connect.mockImplementation(async () => {
      attribution.recordSshConnectionOpened(opened)
      mocks.getConnection.mockReturnValue(opened)
      return opened
    })
    mocks.census.mockResolvedValue({})
    await attribution.runAttributedToSshOwner(decision, () => censusHostRelayTerminalsFor(target)())
    expect(mocks.disconnectConnection).not.toHaveBeenCalled()
    expect(attribution.isSshConnectionSolelyOwnedBy(opened, decision)).toBe(true)
  })
})
