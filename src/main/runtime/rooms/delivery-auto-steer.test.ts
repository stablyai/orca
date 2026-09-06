import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomDatabase } from './database'
import type { RoomAttachmentManager } from './attachments'
import { RoomDeliveryWorker } from './delivery-worker'
import { roomHarnessAdapterTestRecord } from './room-harness-adapter-test-record'

describe('room agent auto-steer', () => {
  let dispose: (() => void) | undefined
  afterEach(() => dispose?.())

  it.each([false, true])('honors live steering enabled=%s', async (enabled) => {
    const harness = setup(enabled)
    dispose = harness.dispose
    harness.worker.start()

    if (enabled) {
      await vi.waitFor(() => expect(harness.steer).toHaveBeenCalledOnce())
      expect(harness.db.messages.deliveries.get(harness.deliveryId)).toMatchObject({
        state: 'delivering',
        intent: 'steer',
        attempts: 1
      })
      return
    }

    await vi.waitFor(() => expect(harness.status).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(harness.steer).not.toHaveBeenCalled()
    expect(harness.db.messages.deliveries.get(harness.deliveryId)).toMatchObject({
      state: 'pending',
      intent: 'next',
      attempts: 0
    })
  })

  it('keeps a rejected automatic steer in its original queue position', async () => {
    const harness = setup(true, true)
    dispose = harness.dispose
    const position = harness.db.messages.deliveries.get(harness.deliveryId).queuePosition
    harness.worker.start()

    await vi.waitFor(() =>
      expect(harness.db.messages.deliveries.get(harness.deliveryId)).toMatchObject({
        state: 'pending',
        intent: 'next',
        attempts: 1,
        error: 'codex_steer_rejected'
      })
    )
    expect(harness.db.messages.deliveries.get(harness.deliveryId).queuePosition).toBe(position)
  })

  it('offers multiple agent deliveries to one target sequentially', () => {
    const harness = setup(true)
    dispose = harness.dispose
    const second = harness.db.messages.create({
      roomId: harness.roomId,
      senderId: harness.senderId,
      senderIdentity: 'claude',
      actorKind: 'agent',
      body: 'later context',
      targetParticipantIds: [harness.targetId]
    }).deliveries[0]

    expect(harness.db.messages.deliveries.listAutoSteerDue()).toMatchObject([
      { id: harness.deliveryId }
    ])

    const first = harness.db.messages.deliveries.claimSteer(harness.deliveryId)!
    harness.db.messages.deliveries.confirmTurn(first.id, 'turn-1')
    expect(harness.db.messages.deliveries.listAutoSteerDue()).toMatchObject([{ id: second.id }])
  })
})

function setup(enabled: boolean, reject = false) {
  const status = vi.fn(async () => ({
    handle: 'conversation-1',
    isRunningAgent: true,
    status: 'working' as const
  }))
  const steer = vi.fn(async () => {
    if (reject) {
      throw new Error('codex_steer_rejected')
    }
    return { handle: 'conversation-1', accepted: true, bytesWritten: 12 }
  })
  const db = new RoomDatabase(':memory:')
  const room = db.createRoom({ projectId: 'project-1', name: 'Research' })
  const sender = db.participants.add({
    roomId: room.room.id,
    identity: 'claude',
    displayName: 'Claude',
    agent: 'claude'
  })
  const target = db.participants.add({
    roomId: room.room.id,
    identity: 'codex',
    displayName: 'Codex',
    agent: 'codex',
    worktreeId: 'worktree-1',
    providerSession: { key: 'session_id', id: 'conversation-1', transport: 'machine' }
  })
  const delivery = db.messages.create({
    roomId: room.room.id,
    senderId: sender.id,
    senderIdentity: sender.identity,
    actorKind: 'agent',
    body: 'live context',
    targetParticipantIds: [target.id]
  }).deliveries[0]
  const worker = new RoomDeliveryWorker(
    db,
    roomHarnessAdapterTestRecord({ status, steer }),
    { size: async () => 0 } as unknown as RoomAttachmentManager,
    () => {},
    async (id) => db.participants.get(id),
    undefined,
    () => enabled
  )
  return {
    db,
    worker,
    roomId: room.room.id,
    senderId: sender.id,
    targetId: target.id,
    deliveryId: delivery.id,
    status,
    steer,
    dispose: () => {
      worker.dispose()
      db.close()
    }
  }
}
