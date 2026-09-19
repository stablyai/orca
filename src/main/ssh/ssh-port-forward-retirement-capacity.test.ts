import { expect, it, vi } from 'vitest'
import { SshPortForwardRetirementCohort } from './ssh-port-forward-retirement-cohort'
import { SshPortForwardManager } from './ssh-port-forward'
import type { SshConnection } from './ssh-connection'
import type { PortForwardStartOptions, StartedPortForward } from './ssh-port-forward-provider'

function forward(): StartedPortForward {
  return {
    entry: {
      id: 'forward',
      connectionId: 'target',
      localPort: 0,
      remoteHost: 'remote',
      remotePort: 80
    },
    close: async () => {},
    dispose: () => {},
    fenceForDrain: () => ({ drain: async () => {}, assertDrained: () => {} })
  }
}

it('reserves pending startup capacity before any provider effect', async () => {
  const cohort = new SshPortForwardRetirementCohort(1)
  const pending = Promise.withResolvers<StartedPortForward>()
  const first = cohort.start(() => pending.promise)
  const effect = vi.fn(async () => forward())
  await expect(cohort.start(effect)).rejects.toThrow('capacity_exhausted')
  expect(effect).not.toHaveBeenCalled()
  const fence = cohort.fenceForDrain()
  const done = vi.fn()
  const waiting = fence.drain(new AbortController().signal).then(done)
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  pending.resolve(forward())
  await Promise.all([first, waiting])
  fence.assertDrained()
})

it('retains a reserved slot for rollback after failed replacement startup', async () => {
  const cohort = new SshPortForwardRetirementCohort(1)
  const reservation = cohort.reserveStart()
  await expect(
    reservation.start(async () => {
      throw new Error('bind failed')
    })
  ).rejects.toThrow('bind failed')
  await expect(cohort.start(async () => forward())).rejects.toThrow('capacity_exhausted')
  const fence = cohort.fenceForDrain()
  await reservation.start(async () => forward())
  await expect(reservation.start(async () => forward())).rejects.toThrow('reservation_consumed')
  reservation.release()
  reservation.release()
  await fence.drain(new AbortController().signal)
  fence.assertDrained()
})

it('reclaims capacity only from a proven retirement, not an uncertain old instance', async () => {
  const cohort = new SshPortForwardRetirementCohort(1)
  const first = await cohort.start(async () => forward())
  await first.close()
  await expect(cohort.start(async () => forward())).rejects.toThrow('capacity_exhausted')
  Object.assign(first, { retirementConfirmed: true })
  await expect(cohort.start(async () => forward())).resolves.toBeDefined()
})

it('releases failed unreturned startup reservations without inventing a retirement receipt', async () => {
  const cohort = new SshPortForwardRetirementCohort(1)
  await expect(
    cohort.start(async () => {
      throw new Error('not started')
    })
  ).rejects.toThrow('not started')
  await expect(cohort.start(async () => forward())).resolves.toBeDefined()
})

it('cannot release an in-flight reservation or publish through a released permit', async () => {
  const cohort = new SshPortForwardRetirementCohort(1)
  const reservation = cohort.reserveStart()
  const pending = Promise.withResolvers<StartedPortForward>()
  const opening = reservation.start(() => pending.promise)
  expect(() => reservation.release()).toThrow('reservation_pending')
  pending.reject(new Error('start refused'))
  await expect(opening).rejects.toThrow('start refused')
  reservation.release()
  const effect = vi.fn(async () => forward())
  await expect(reservation.start(effect)).rejects.toThrow('reservation_consumed')
  expect(effect).not.toHaveBeenCalled()
})

it('manager refuses saturated updates before removing the existing forward', async () => {
  const close = vi.fn(async () => {})
  const start = vi.fn(async (_connection: SshConnection, options: PortForwardStartOptions) => ({
    ...forward(),
    entry: { ...options },
    close
  }))
  const manager = new SshPortForwardManager({}, [{ canHandle: () => true, start }])
  const connection = {} as SshConnection
  const entries = await Promise.all(
    Array.from({ length: 256 }, () => manager.addForward('target', connection, 0, 'remote', 80))
  )
  await expect(manager.addForward('target', connection, 0, 'remote', 80)).rejects.toThrow(
    'capacity_exhausted'
  )
  await expect(manager.updateForward(entries[0].id, connection, 0, 'other', 81)).rejects.toThrow(
    'capacity_exhausted'
  )
  expect(start).toHaveBeenCalledTimes(256)
  expect(close).not.toHaveBeenCalled()
  expect(manager.listForwards()).toEqual(entries)
  await expect(
    manager.addForward('other-target', connection, 0, 'remote', 80)
  ).resolves.toBeDefined()
})
