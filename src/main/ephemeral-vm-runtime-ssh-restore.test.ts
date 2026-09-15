import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime,
  updateEphemeralVmRuntimeStatus
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'

const { connect, getTarget, wait } = vi.hoisted(() => ({
  connect: vi.fn(),
  getTarget: vi.fn(),
  wait: vi.fn()
}))
vi.mock('./ssh/ssh-target-registry', () => ({
  connectRegisteredSshTarget: connect,
  getSshTargetRegistryStore: () => ({ getTarget })
}))
vi.mock('./ephemeral-vm-runtime-ssh', () => ({ waitForRuntimeSshProviders: wait }))
import {
  restoreRuntimeOwnedSshTarget,
  restoreRunningRuntimeOwnedSshTargets
} from './ephemeral-vm-runtime-ssh-restore'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-reattach-'))
  connect.mockReset().mockResolvedValue({ status: 'connected' })
  wait.mockReset().mockResolvedValue(undefined)
  getTarget.mockReset().mockImplementation((id: string) => ({
    id,
    owner: { type: 'on-demand-runtime', runtimeId: id.replace('runtime-ssh-', '') }
  }))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})
/**
 * Persist a running SSH runtime fixture, with overrides for lifecycle and ownership cases.
 */
function add(id: string, overrides: Partial<EphemeralVmRuntimeRecord> = {}): void {
  upsertEphemeralVmRuntime(dir, {
    id,
    recipeId: 'vm',
    repoId: 'repo',
    workspaceId: `repo::/${id}`,
    connectionMode: 'ssh',
    sshTargetId: `runtime-ssh-${id}`,
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/repo',
        target: { label: 'VM', host: 'localhost', port: 2222, username: 'node' }
      }
    },
    ...overrides
  })
}
it('reattaches a running VM without modifying its lifecycle or re-provisioning its registration', async () => {
  add('a')
  const before = listEphemeralVmRuntimes(dir)
  await restoreRuntimeOwnedSshTarget(dir, 'a')
  expect(connect).toHaveBeenCalledWith('runtime-ssh-a')
  expect(wait).toHaveBeenCalledWith('runtime-ssh-a')
  expect(listEphemeralVmRuntimes(dir)).toEqual(before)
})
it('does not connect suspended, cleaned, provisioning, or paired runtimes', async () => {
  add('sleeping', { status: 'suspended' })
  add('deleted', { status: 'cleaned' })
  add('creating', { status: 'provisioning' })
  add('paired', { runtimeEnvironmentId: 'remote-server' })
  await restoreRunningRuntimeOwnedSshTargets(dir)
  expect(connect).not.toHaveBeenCalled()
})
it('fails closed on missing or wrong-owner registrations', async () => {
  add('a')
  getTarget.mockReturnValue(undefined)
  await expect(restoreRuntimeOwnedSshTarget(dir, 'a')).rejects.toThrow('missing')
  getTarget.mockReturnValue({
    id: 'runtime-ssh-a',
    owner: { type: 'on-demand-runtime', runtimeId: 'b' }
  })
  await expect(restoreRuntimeOwnedSshTarget(dir, 'a')).rejects.toThrow('missing')
  expect(connect).not.toHaveBeenCalled()
})
it('retains a failed connection for a later activation retry', async () => {
  add('a')
  connect.mockRejectedValueOnce(new Error('offline'))
  await expect(restoreRuntimeOwnedSshTarget(dir, 'a')).rejects.toThrow('offline')
  expect(listEphemeralVmRuntimes(dir)[0].status).toBe('running')
  await restoreRuntimeOwnedSshTarget(dir, 'a')
  expect(connect).toHaveBeenCalledTimes(2)
})
it('bounds startup fanout and rechecks queued lifecycle state', async () => {
  for (let i = 0; i < 6; i++) {
    add(String(i))
  }
  const pending: (() => void)[] = []
  connect.mockImplementation(
    () => new Promise((resolve) => pending.push(() => resolve({ status: 'connected' })))
  )
  const restoring = restoreRunningRuntimeOwnedSshTargets(dir)
  expect(connect).toHaveBeenCalledTimes(4)
  const queued = listEphemeralVmRuntimes(dir).filter(
    (r) => !connect.mock.calls.some(([id]) => id === r.sshTargetId)
  )
  for (const runtime of queued) {
    updateEphemeralVmRuntimeStatus(dir, runtime.id, { status: 'suspended' })
  }
  for (const done of pending) {
    done()
  }
  await restoring
  expect(connect).toHaveBeenCalledTimes(4)
})
