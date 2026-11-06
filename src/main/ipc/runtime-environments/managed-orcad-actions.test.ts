import { beforeEach, describe, expect, it, vi } from 'vitest'

const { managedServer, statusActivations } = vi.hoisted(() => ({
  managedServer: {
    id: 'env-1',
    orcadDeployment: {
      kind: 'ssh',
      requestId: 'request-1',
      sshTargetId: 'ssh-1',
      sshTargetGeneration: 1,
      localPort: 41000,
      remotePort: 6768
    }
  },
  statusActivations: vi.fn()
}))
vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: () => managedServer,
  listEnvironments: () => [managedServer]
}))
vi.mock('../../ssh/orcad-runtime-maintenance', () => ({
  updateManagedOrcadEnvironment: vi.fn(async () => ({ outcome: 'deferred' })),
  recoverManagedOrcadEnvironment: vi.fn(async () => ({ outcome: 'refused' })),
  rollbackManagedOrcadEnvironment: vi.fn(async () => ({ outcome: 'refused' }))
}))
vi.mock('./runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusOwner: () => ({ activate: statusActivations })
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-launch-session', () => ({
  restartManagedOrcadEnvironment: vi.fn(async () => ({ outcome: 'refused' }))
}))

import { getManagedOrcadCrashLoopBrake } from '../../managed-server/lifecycle/orcad-managed-crash-loop'
import { updateManagedOrcadEnvironment } from '../../ssh/orcad-runtime-maintenance'
import { isSshUserDisconnected, recordSshUserDisconnected } from '../../ssh/ssh-user-disconnect'
import { createManagedOrcadActions, restartManagedOrcad } from './managed-orcad-actions'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  markRuntimeEnvironmentManuallyDisconnected
} from './runtime-environment-manual-disconnect'

const CRASHED = { pid: 4242, version: '1.2.3', acquiredAt: '2026-11-04T10:00:00.000Z' }
const options = {
  getUserDataPath: () => '/user-data',
  getActiveEnvironmentId: () => null,
  invalidateTransport: () => {},
  clearHostServerNotes: () => {},
  clearHostServerStatus: () => {},
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these actions never reach the removal store.
  store: {} as never
}

function brakeHost(): void {
  const brake = getManagedOrcadCrashLoopBrake()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only previousUnexpectedExit is read.
  const health = { previousUnexpectedExit: CRASHED } as never
  for (let i = 0; i < 3; i++) {
    brake.noteStarted('env-1', brake.resetEpoch('env-1'), health)
  }
  expect(brake.engaged('env-1')).toBe(true)
}

beforeEach(() => {
  getManagedOrcadCrashLoopBrake().forget('env-1')
})

// A user's server action is explicit, like Connect.
describe('explicit server actions on a host braked for crashing', () => {
  it('Restart re-arms automatic starts', async () => {
    brakeHost()
    await restartManagedOrcad(options, 'env-1')
    expect(getManagedOrcadCrashLoopBrake().engaged('env-1')).toBe(false)
  })

  it.each([
    ['Update', () => createManagedOrcadActions(options).update('env-1', false)],
    ['Rollback', () => createManagedOrcadActions(options).rollback('env-1')],
    ['Recover', () => createManagedOrcadActions(options).recover('env-1', false)]
  ])('%s re-arms automatic starts', async (_action, run) => {
    brakeHost()
    await run()
    expect(getManagedOrcadCrashLoopBrake().engaged('env-1')).toBe(false)
  })
})

describe('explicit server actions on a disconnected server', () => {
  it.each([
    ['Update', () => createManagedOrcadActions(options).update('env-1', false)],
    ['Restart', () => restartManagedOrcad(options, 'env-1')]
  ])('%s connects it again, as Connect does', async (_action, run) => {
    markRuntimeEnvironmentManuallyDisconnected('env-1')
    recordSshUserDisconnected('ssh-1')
    await run()
    expect(isRuntimeEnvironmentManuallyDisconnected('env-1')).toBe(false)
    // The SSH host it runs on is connected too, as a server Connect does.
    expect(isSshUserDisconnected('ssh-1')).toBe(false)
  })

  it('resumes its status only once the replaced transport is gone', async () => {
    const order: string[] = []
    statusActivations.mockImplementationOnce(() => order.push('status resumed'))
    vi.mocked(updateManagedOrcadEnvironment).mockResolvedValueOnce(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the action reads only outcome and environment.
      { outcome: 'updated', environment: managedServer } as never
    )
    markRuntimeEnvironmentManuallyDisconnected('env-1')
    await createManagedOrcadActions({
      ...options,
      invalidateTransport: () => {
        order.push('transport invalidated')
      }
    }).update('env-1', false)
    expect(order).toEqual(['transport invalidated', 'status resumed'])
  })
})
