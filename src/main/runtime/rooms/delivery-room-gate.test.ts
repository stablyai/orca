import { expect, it, vi } from 'vitest'
import type { RoomDelivery } from '../../../shared/rooms'
import { RoomDeliveryGate } from './delivery-room-gate'

it('keeps claim handoff tracked until its delivery task settles', async () => {
  const gate = new RoomDeliveryGate()
  const child = deferred()
  let fence: ReturnType<RoomDeliveryGate['requestFence']> | null = null
  const claim = gate.startClaim(
    'room-a',
    async () => {
      fence = gate.requestFence('room-a')
      return [{ id: 'delivery-a' } as RoomDelivery]
    },
    () => void gate.startTask('room-a', () => child.promise)
  )

  await expect(claim).resolves.toBe(true)
  const ready = vi.fn()
  void fence!.ready.then(ready)
  await Promise.resolve()
  expect(ready).not.toHaveBeenCalled()

  child.resolve()
  await expect(fence!.ready).resolves.toBe(true)
  fence!.release()
})

it('owns same-room fences FIFO without blocking another room', async () => {
  const gate = new RoomDeliveryGate()
  const first = gate.requestFence('room-a')
  const second = gate.requestFence('room-a')
  const canceled = gate.requestFence('room-a')
  const otherRoom = gate.requestFence('room-b')

  await expect(first.ready).resolves.toBe(true)
  await expect(otherRoom.ready).resolves.toBe(true)
  expect(first.claimAllowed()).toBe(true)
  expect(gate.claimAllowed('room-a')).toBe(false)
  canceled.release()
  await expect(canceled.ready).resolves.toBe(false)
  expect(gate.claimAllowed('room-a')).toBe(false)

  first.release()
  await expect(second.ready).resolves.toBe(true)
  expect(gate.claimAllowed('room-a')).toBe(false)
  second.release()
  otherRoom.release()
  expect(gate.claimAllowed('room-a')).toBe(true)
})

it('invalidates an acquired fence when disposed', async () => {
  const gate = new RoomDeliveryGate()
  const fence = gate.requestFence('room-a')

  await expect(fence.ready).resolves.toBe(true)
  gate.dispose()

  expect(fence.claimAllowed()).toBe(false)
  fence.release()
})

it('keeps destructive fences FIFO between short steer admissions and drains registered deliveries', async () => {
  const gate = new RoomDeliveryGate()
  const child = deferred()
  const first = gate.requestFence('room-a', false)
  await first.ready
  const delivery = gate.startTask('room-a', () => child.promise)
  first.release()
  const independent = gate.requestFence('room-a', false)
  await independent.ready
  const deleting = gate.requestFence('room-a')
  const later = gate.requestFence('room-a', false)
  independent.release()
  let deleteReady = false
  void deleting.ready.then(() => {
    deleteReady = true
  })
  await new Promise(setImmediate)
  expect(deleteReady).toBe(false)
  expect(later.claimAllowed()).toBe(false)
  child.resolve()
  await delivery
  await deleting.ready
  expect(later.claimAllowed()).toBe(false)
  deleting.release()
  await later.ready
  expect(later.claimAllowed()).toBe(true)
  later.release()
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
