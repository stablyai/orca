import { beforeEach, expect, it, vi } from 'vitest'
import { createEnvironmentFromPairingOffer } from '../../shared/runtime-environments'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { runRuntimeEnvironmentReconciliationLifecycle } from './runtime-environment-reconciliation-lifecycle'

const resolve = vi.hoisted(() => vi.fn())
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: resolve }))
function environment(id: string) {
  return createEnvironmentFromPairingOffer({
    id,
    name: id,
    now: 1,
    runtimeId: 'host',
    connectionDependency: 'ssh-tunnel',
    orcadDeployment: {
      sshTargetId: `target-${id}`,
      sshTargetGeneration: 1,
      localPort: 41000,
      remotePort: 6768
    },
    offer: { v: 2, endpoint: 'ws://127.0.0.1:41000', publicKeyB64: 'key', deviceToken: 'grant' }
  })
}
let registrations: ReturnType<typeof environment>[]
beforeEach(() => {
  registrations = [environment('left'), environment('right')]
  resolve
    .mockReset()
    .mockImplementation((_path, id) => registrations.find((entry) => entry.id === id))
})

it.each(['target-left', 'runtime-ssh-access:/profile:left'])(
  'waits for existing lifecycle %s before probing or preparing',
  async (key) => {
    const gate = Promise.withResolvers<void>()
    const holding = runTargetLifecycle(key, () => gate.promise)
    const operation = vi.fn(async () => 'prepared')
    const preparing = runRuntimeEnvironmentReconciliationLifecycle(
      '/profile',
      registrations,
      operation
    )
    await Promise.resolve()
    expect(operation).not.toHaveBeenCalled()
    gate.resolve()
    await holding
    await expect(preparing).resolves.toBe('prepared')
  }
)

it('refuses authority changed while waiting for a target', async () => {
  const gate = Promise.withResolvers<void>()
  const holding = runTargetLifecycle('target-left', () => gate.promise)
  const operation = vi.fn(async () => {})
  const preparing = runRuntimeEnvironmentReconciliationLifecycle(
    '/profile',
    registrations,
    operation
  )
  const rejected = expect(preparing).rejects.toThrow('changed')
  registrations = [{ ...registrations[0], pairingRevision: 2 }, registrations[1]]
  gate.resolve()
  await holding
  await rejected
  expect(operation).not.toHaveBeenCalled()
})

it('serializes reversed selection orders without deadlocking', async () => {
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const events: string[] = []
  const first = runRuntimeEnvironmentReconciliationLifecycle(
    '/profile',
    registrations,
    async () => {
      events.push('first')
      entered.resolve()
      await gate.promise
      events.push('first-complete')
    }
  )
  await entered.promise
  const second = runRuntimeEnvironmentReconciliationLifecycle(
    '/profile',
    registrations.toReversed(),
    async () => {
      events.push('second')
    }
  )
  gate.resolve()
  await Promise.all([first, second])
  expect(events).toEqual(['first', 'first-complete', 'second'])
})

it('does not hold lifecycle queues after a failed operation', async () => {
  await expect(
    runRuntimeEnvironmentReconciliationLifecycle('/profile', registrations, async () => {
      throw new Error('failed proof')
    })
  ).rejects.toThrow('failed proof')
  await expect(
    runRuntimeEnvironmentReconciliationLifecycle('/profile', registrations, async () => 'retry')
  ).resolves.toBe('retry')
})
