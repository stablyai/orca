import { expect, it, vi } from 'vitest'
import { RoomDatabase } from './database'
import { roomHarnessAdapterTestRecord } from './room-harness-adapter-test-record'
import type { RoomAttachmentManager } from './attachments'
import { RoomDeliveryWorker } from './delivery-worker'

it('preserves another delivery confirmation deadline while steering', async () => {
  let status: 'ready' | 'working' = 'ready'
  const snapshot = () => ({
    id: 'conversation-1',
    agent: 'codex',
    cwd: '/repo',
    providerSessionId: 'session-1',
    messages: [],
    queuedMessages: [],
    queueRevision: 0,
    status,
    updatedAt: 1
  })
  const deliver = vi.fn(async () => ({ handle: snapshot().id, accepted: true, bytesWritten: 1 }))
  const adapters = roomHarnessAdapterTestRecord({
    status: async () => ({
      handle: snapshot().id,
      isRunningAgent: true,
      status: status === 'working' ? 'working' : 'idle'
    }),
    send: deliver,
    steer: deliver
  })
  const db = new RoomDatabase(':memory:')
  const room = db.createRoom({ projectId: 'project-1', name: 'Research' })
  const participant = db.participants.add({
    roomId: room.room.id,
    identity: 'codex',
    displayName: 'Codex',
    agent: 'codex',
    worktreeId: 'worktree-1',
    providerSession: { key: 'session_id', id: snapshot().id, transport: 'machine' }
  })
  const first = db.messages.create({
    roomId: room.room.id,
    senderId: room.participants[0].id,
    senderIdentity: room.participants[0].identity,
    actorKind: 'user',
    body: 'first'
  }).deliveries[0]
  const worker = new RoomDeliveryWorker(
    db,
    adapters,
    { size: async () => 0 } as unknown as RoomAttachmentManager,
    () => {},
    async (id) => db.participants.get(id),
    1_000
  )
  try {
    worker.start()
    await vi.waitFor(() =>
      expect(db.messages.deliveries.get(first.id)).toMatchObject({
        state: 'delivering',
        phase: 'awaiting-turn'
      })
    )
    status = 'working'
    const second = db.messages
      .create({
        roomId: room.room.id,
        senderId: room.participants[0].id,
        senderIdentity: room.participants[0].identity,
        actorKind: 'user',
        body: 'steer'
      })
      .deliveries.find((delivery) => delivery.participantId === participant.id)!

    await worker.steer(second.id, true)
    status = 'ready'
    await vi.waitFor(
      () =>
        expect(db.messages.deliveries.get(first.id)).toMatchObject({
          state: 'failed',
          error: 'room_delivery_uncertain'
        }),
      { timeout: 2_000 }
    )
  } finally {
    worker.dispose()
    db.close()
  }
})
