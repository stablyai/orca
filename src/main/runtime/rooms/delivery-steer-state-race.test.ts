import { describe, expect, it, vi } from 'vitest'
import type { RoomHarnessAgent } from '../../../shared/rooms'
import { RoomDatabase } from './database'
import type { RoomHarnessAdapter } from './harness-adapter'
import { claimRoomSteer } from './delivery-steer-selection'

describe('room Steer state races', () => {
  it('rejects directed Steer when participant state changes after its probe', async () => {
    await expectDirectedRaceRejected((db, participantId) => {
      db.participants.update(participantId, { state: 'online' })
    })
  })

  it('rejects directed Steer when process incarnation changes after its probe', async () => {
    await expectDirectedRaceRejected((db, participantId) => {
      db.participants.update(participantId, { processIncarnation: 'machine:rebound' })
    })
  })

  it('rejects directed Steer when claim permission is revoked after its probe', async () => {
    let allowed = true
    await expectDirectedRaceRejected(
      () => (allowed = false),
      () => allowed,
      'room_delivery_worker_disposed'
    )
  })

  it('rejects shared Steer when a classified participant state changes', async () => {
    const db = new RoomDatabase(':memory:')
    const room = db.createRoom({ projectId: 'project', name: 'room' })
    const codex = addMachine(db, room.room.id, 'codex', 'codex')
    addMachine(db, room.room.id, 'claude', 'claude')
    db.participants.update(codex.id, { state: 'busy' })
    const created = createMessage(db, room)
    const selected = created.deliveries.find((delivery) => delivery.participantId === codex.id)!
    const secondProbe = deferred()
    const releaseSecond = deferred()
    const steering = claimRoomSteer(
      db,
      {
        codex: adapter(async () => 'working'),
        claude: adapter(async () => {
          secondProbe.resolve()
          await releaseSecond.promise
          return 'idle'
        })
      },
      selected.id,
      true
    )
    try {
      await secondProbe.promise
      db.participants.update(codex.id, { state: 'online' })
      releaseSecond.resolve()

      await expect(steering).rejects.toThrow('room_delivery_queue_stale')
      expect(db.messages.deliveries.listForMessage(created.message.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: 'pending', intent: 'next', attempts: 0 }),
          expect.objectContaining({ state: 'pending', intent: 'next', attempts: 0 })
        ])
      )
    } finally {
      releaseSecond.resolve()
      db.close()
    }
  })
})

async function expectDirectedRaceRejected(
  mutate: (db: RoomDatabase, participantId: string) => void,
  claimAllowed: () => boolean = () => true,
  error = 'room_delivery_queue_stale'
): Promise<void> {
  const db = new RoomDatabase(':memory:')
  const room = db.createRoom({ projectId: 'project', name: 'room' })
  const codex = addMachine(db, room.room.id, 'codex', 'codex')
  addMachine(db, room.room.id, 'claude', 'claude')
  db.participants.update(codex.id, { state: 'busy' })
  const created = createMessage(db, room, [codex.id])
  const probe = deferred()
  const release = deferred()
  const steering = claimRoomSteer(
    db,
    {
      codex: adapter(async () => {
        probe.resolve()
        await release.promise
        return 'working'
      })
    },
    created.deliveries[0]!.id,
    false,
    claimAllowed
  )
  try {
    await probe.promise
    mutate(db, codex.id)
    release.resolve()

    await expect(steering).rejects.toThrow(error)
    expect(db.messages.deliveries.get(created.deliveries[0]!.id)).toMatchObject({
      state: 'pending',
      intent: 'next',
      attempts: 0
    })
  } finally {
    release.resolve()
    db.close()
  }
}

function addMachine(db: RoomDatabase, roomId: string, identity: string, agent: RoomHarnessAgent) {
  return db.participants.add({
    roomId,
    identity,
    displayName: identity,
    agent,
    worktreeId: `worktree-${identity}`,
    providerSession: {
      key: 'session_id',
      id: `session-${identity}`,
      transport: 'machine'
    }
  })
}

function createMessage(
  db: RoomDatabase,
  room: ReturnType<RoomDatabase['createRoom']>,
  targetParticipantIds?: string[]
) {
  return db.messages.create({
    roomId: room.room.id,
    senderId: room.participants[0].id,
    senderIdentity: room.participants[0].identity,
    actorKind: 'user',
    body: 'queued',
    targetParticipantIds
  })
}

function adapter(getStatus: () => Promise<'idle' | 'working'>): RoomHarnessAdapter {
  return {
    steer: vi.fn(),
    status: vi.fn(async () => ({
      handle: 'machine',
      isRunningAgent: true,
      status: await getStatus()
    }))
  } as unknown as RoomHarnessAdapter
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
