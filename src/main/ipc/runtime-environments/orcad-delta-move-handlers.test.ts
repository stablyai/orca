import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  move: vi.fn(),
  keep: vi.fn(async () => {}),
  publish: vi.fn(),
  ensure: vi.fn(),
  destinationFor: vi.fn((_environment: unknown) => ({})),
  target: {
    id: 'ssh-1',
    label: 'Box',
    host: 'box',
    port: 22,
    username: 'me',
    orcadFence: { environmentId: 'env-1', sourceChangedAt: '2026-10-04T00:00:00.000Z' }
  }
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../../shared/runtime-environment-store', () => ({
  listEnvironments: () => [{ id: 'env-1' }]
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-runtime-context', () => ({
  requireManagedOrcadInfrastructure: () => ({
    claims: {},
    targetStore: { getOrcadMigrationSource: () => ({ getSshTarget: () => mocks.target }) }
  })
}))
vi.mock('../../ssh/orcad-migration-delta-move', () => ({
  runOrcadDeltaMove: mocks.move,
  keepOrcadServerVersion: mocks.keep
}))
vi.mock('../../managed-server/lifecycle/orcad-runtime-conversion-wiring', () => ({
  orcadMigrationDestinationFor: mocks.destinationFor,
  orcadServerAutomationEnablerFor: () => vi.fn()
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  ensureOrcadManagedTunnel: mocks.ensure
}))
vi.mock('../ssh/ssh-session-teardown', () => ({
  disconnectRegisteredSshTarget: vi.fn()
}))
vi.mock('./runtime-environment-managed-tunnel', () => ({
  publishResolvedChangedHostStatus: mocks.publish
}))

const { registerOrcadDeltaMoveHandlers } = await import('./orcad-delta-move-handlers')

function handler(channel: string): (_event: unknown, args: unknown) => Promise<unknown> {
  const registration = mocks.handle.mock.calls.find(([name]) => name === channel)
  if (!registration) {
    throw new Error(`${channel} handler was not registered`)
  }
  return registration[1]
}

describe('resolving a host an older build changed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerOrcadDeltaMoveHandlers(() => '/tmp/user-data')
  })

  it('builds the destination from the pairing the tunnel stands on after opening', async () => {
    // Opening the tunnel can replace the saved SSH pairing.
    const repaired = { id: 'env-1', pairingRevision: 2 }
    mocks.ensure.mockResolvedValue(repaired)
    const destination = { committed: true }
    mocks.destinationFor.mockReturnValue(destination)
    mocks.move.mockImplementation(async (args: { connectDestination: () => Promise<unknown> }) => {
      await expect(args.connectDestination()).resolves.toBe(destination)
      return { outcome: 'moved', migrationId: 'm-1' }
    })
    await expect(
      handler('runtimeEnvironments:moveOrcadDelta')(null, { sshTargetId: 'ssh-1' })
    ).resolves.toMatchObject({ outcome: 'moved' })
    expect(mocks.destinationFor).toHaveBeenCalledExactlyOnceWith(repaired)
  })

  it('refreshes the host status once the move lands, and not when it is refused', async () => {
    mocks.move.mockResolvedValueOnce({ outcome: 'refused', code: 'x', reason: 'y' })
    await handler('runtimeEnvironments:moveOrcadDelta')(null, { sshTargetId: 'ssh-1' })
    expect(mocks.publish).not.toHaveBeenCalled()
    mocks.move.mockResolvedValueOnce({ outcome: 'moved', migrationId: 'm' })
    await handler('runtimeEnvironments:moveOrcadDelta')(null, { sshTargetId: 'ssh-1' })
    expect(mocks.publish).toHaveBeenCalledWith(mocks.target, 'env-1', 0)
  })

  it('refreshes the host status after keeping the server version', async () => {
    await handler('runtimeEnvironments:keepOrcadServerVersion')(null, { sshTargetId: 'ssh-1' })
    expect(mocks.keep).toHaveBeenCalled()
    expect(mocks.publish).toHaveBeenCalledWith(mocks.target, 'env-1')
  })
})
