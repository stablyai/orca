import { expect, it, vi } from 'vitest'
import { RoomDatabase } from './database'
import { RoomDeliveryWorker } from './delivery-worker'
import type { RoomAttachmentManager } from './attachments'
import { roomHarnessAdapterTestRecord } from './room-harness-adapter-test-record'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(automatic = false) {
  const db = new RoomDatabase(':memory:')
  const room = db.createRoom({ projectId: 'project', name: 'room' })
  const slow = deferred()
  const participants = ['claude', 'codex', 'codex2'].map((identity) => {
    const p = db.participants.add({
      roomId: room.room.id,
      identity,
      displayName: identity,
      agent: identity === 'claude' ? 'claude' : 'codex',
      worktreeId: 'worktree',
      providerSession: { key: 'session_id', id: identity, transport: 'machine' }
    })
    return db.participants.update(p.id, { state: 'busy' })
  })
  const steer = vi.fn(async (binding) => {
    if (binding.providerSession.id === 'claude') {
      await slow.promise
    }
    return { handle: binding.providerSession.id, accepted: true, bytesWritten: 1 }
  })
  const worker = new RoomDeliveryWorker(
    db,
    roomHarnessAdapterTestRecord({
      status: async () => ({ handle: 'session', isRunningAgent: true, status: 'working' }),
      steer
    }),
    { size: async () => 0 } as unknown as RoomAttachmentManager,
    () => {},
    async (id) => db.participants.get(id),
    undefined,
    () => automatic
  )
  const create = (index: number) =>
    db.messages.create({
      roomId: room.room.id,
      senderId: automatic ? participants[2]!.id : room.participants[0]!.id,
      senderIdentity: automatic ? 'codex2' : 'user',
      actorKind: automatic ? 'agent' : 'user',
      body: 'continue',
      targetParticipantIds: [participants[index]!.id]
    }).deliveries[0]!
  const runs: Promise<unknown>[] = []
  return {
    db,
    roomId: room.room.id,
    worker,
    slow,
    steer,
    create,
    runs,
    async close() {
      slow.resolve()
      await Promise.allSettled(runs)
      worker.dispose()
      db.close()
    }
  }
}

it('steers Codex while Claude is awaiting acknowledgement, but Stop still drains both', async () => {
  const h = setup()
  try {
    const claude = h.create(0),
      codex = h.create(1)
    h.runs.push(h.worker.steer(claude.id))
    await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1))
    const fast = h.worker.steer(codex.id)
    h.runs.push(fast)
    await fast
    expect(h.steer).toHaveBeenCalledTimes(2)
    const fence = h.worker.requestRoomFence(h.roomId, { discardConfirmations: false })
    let stopped = false
    void fence.ready.then(() => {
      stopped = true
    })
    await new Promise(setImmediate)
    expect(stopped).toBe(false)
    h.slow.resolve()
    await fence.ready
    fence.release()
  } finally {
    await h.close()
  }
})

it('rechecks a same-participant contender after admission, without a duplicate send', async () => {
  const h = setup()
  try {
    const first = h.create(0),
      second = h.create(0)
    h.runs.push(h.worker.steer(first.id))
    const duplicate = h.worker.steer(second.id)
    h.runs.push(duplicate)
    await expect(duplicate).rejects.toThrow('conversation_steer_busy')
    expect(h.steer).toHaveBeenCalledTimes(1)
    expect(h.db.messages.deliveries.get(second.id)).toMatchObject({ state: 'pending', attempts: 0 })
  } finally {
    await h.close()
  }
})

it('does not let an automatic slow steer block another participant or a later drain', async () => {
  const h = setup(true)
  try {
    h.create(0)
    h.worker.start()
    await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1))
    h.create(1)
    h.worker.wake()
    await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(2))
    h.slow.resolve()
    const fence = h.worker.requestRoomFence(h.roomId, { discardConfirmations: false })
    await fence.ready
    fence.release()
  } finally {
    await h.close()
  }
})
