import { expect, it, vi } from 'vitest'
import type { RoomHarnessRuntime } from './harness-adapter'
import { RoomService } from './service'
import { roomHarnessAdapterTestRecord } from './room-harness-adapter-test-record'

it.each([{ contender: 'stop' as const }, { contender: 'delete' as const }])(
  'serializes delayed shared Steer with room $contender',
  async ({ contender }) => {
    const statusStarted = deferred()
    const releaseStatus = deferred()
    let firstRead = true
    const snapshot = () => ({
      id: 'conversation-1',
      agent: 'codex',
      cwd: '/repo',
      providerSessionId: 'session-1',
      messages: [],
      queuedMessages: [],
      queueRevision: 0,
      status: 'working',
      updatedAt: 1
    })
    const steer = vi.fn(async () => ({ handle: snapshot().id, accepted: true, bytesWritten: 1 }))
    const runtime = {
      listRoomRunningAgents: async () => [],
      listRoomExistingAgents: async () => []
    } as unknown as RoomHarnessRuntime
    const adapters = roomHarnessAdapterTestRecord({
      status: async () => {
        if (firstRead) {
          firstRead = false
          statusStarted.resolve()
          await releaseStatus.promise
        }
        return { handle: snapshot().id, isRunningAgent: true, status: 'working' }
      },
      steer,
      interrupt: async () => undefined,
      stop: async () => ({ handle: snapshot().id, tabId: snapshot().id, ptyKilled: true })
    })
    const service = new RoomService(':memory:', runtime, adapters)
    const room = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const participant = service.db.participants.add({
      roomId: room.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      providerSession: { key: 'session_id', id: snapshot().id, transport: 'machine' }
    })
    const delivery = service.db.messages
      .create({
        roomId: room.room.id,
        senderId: room.participants[0].id,
        senderIdentity: room.participants[0].identity,
        actorKind: 'user',
        body: 'steer'
      })
      .deliveries.find((candidate) => candidate.participantId === participant.id)!
    try {
      const steering = service.queue.steer(delivery.id, true)
      await statusStarted.promise
      const competing =
        contender === 'stop' ? service.stopRoom(room.room.id) : service.deleteRoom(room.room.id)
      releaseStatus.resolve()

      if (contender === 'stop') {
        await expect(steering).rejects.toThrow('room_delivery_queue_stale')
        await expect(competing).resolves.toBeTypeOf('number')
        expect(steer).not.toHaveBeenCalled()
      } else {
        await expect(steering).resolves.toBeUndefined()
        await expect(competing).resolves.toBeUndefined()
        expect(steer).toHaveBeenCalledOnce()
        expect(() => service.db.core.get(room.room.id)).toThrow('room_not_found')
      }
    } finally {
      releaseStatus.resolve()
      service.close()
    }
  }
)

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
