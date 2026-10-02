import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomDatabase } from './database'
import { claimRoomBroadcastForTest } from './delivery-test-claim'
import { updateRoomParticipant } from './participant-participation'

describe('room participant participation', () => {
  let database: RoomDatabase | undefined

  afterEach(() => database?.close())

  it('suppresses an unattempted queue target on pause without resurrecting it', () => {
    database = new RoomDatabase(':memory:')
    const snapshot = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const agents = ['codex', 'claude', 'gemini'].map((identity) =>
      database!.participants.add({
        roomId: snapshot.room.id,
        identity,
        displayName: identity,
        agent: identity === 'claude' ? 'claude' : 'codex'
      })
    )
    const created = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'shared'
    })
    const emit = vi.fn()
    const wake = vi.fn()
    const update = (participation: 'active' | 'paused') =>
      updateRoomParticipant(
        database!,
        agents[2]!.id,
        { participation },
        () => undefined,
        emit,
        wake
      )

    update('paused')
    const paused = database.messages.deliveries
      .listForMessage(created.message.id)
      .find((delivery) => delivery.participantId === agents[2]!.id)
    expect(paused).toMatchObject({
      state: 'suppressed',
      error: 'room_participant_paused',
      attempts: 0
    })
    expect(() =>
      database!.messages.deliveries.assertMessageMutable(created.message.id)
    ).not.toThrow()
    expect(database.messages.deliveries.isBroadcastMessage(created.message.id)).toBe(true)
    expect(claimRoomBroadcastForTest(database, created.message.id)).toEqual(
      expect.arrayContaining(
        agents
          .slice(0, 2)
          .map((participant) =>
            expect.objectContaining({ participantId: participant.id, state: 'delivering' })
          )
      )
    )

    update('active')
    expect(database.messages.deliveries.get(paused!.id)).toMatchObject({
      state: 'suppressed',
      error: 'room_participant_paused'
    })
    expect(database.messages.deliveries.isBroadcastMessage(created.message.id)).toBe(false)
    expect(emit).toHaveBeenCalledWith(
      snapshot.room.id,
      expect.objectContaining({ type: 'delivery.updated' })
    )
    expect(wake).toHaveBeenCalledTimes(2)
    expect(
      emit.mock.calls.map(([, event]) => event.type).filter((type) => type === 'room.updated')
    ).toHaveLength(2)
  })

  it('normalizes stopped subset queues when an active participant is paused', () => {
    database = new RoomDatabase(':memory:')
    const snapshot = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const agents = ['alpha', 'beta', 'gamma'].map((identity) =>
      database!.participants.add({
        roomId: snapshot.room.id,
        identity,
        displayName: identity,
        agent: 'codex'
      })
    )
    const create = (body: string, targetParticipantIds?: string[]) =>
      database!.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0].id,
        senderIdentity: snapshot.participants[0].identity,
        actorKind: 'user',
        body,
        targetParticipantIds
      })
    const baseline = create('baseline')
    const first = create(
      'first',
      agents.slice(0, 2).map(({ id }) => id)
    )
    const second = create(
      'second',
      agents.slice(0, 2).map(({ id }) => id)
    )
    database.transaction(() => database!.messages.deliveries.stopRoom(snapshot.room.id))
    const forParticipant = (created: typeof baseline, participantId: string) =>
      database!.messages.deliveries
        .listForMessage(created.message.id)
        .find((delivery) => delivery.participantId === participantId)!
    const betaRows = [baseline, first, second].map((created) =>
      forParticipant(created, agents[1]!.id)
    )
    database.messages.deliveries.reorder(
      agents[1]!.id,
      [betaRows[0]!.id, betaRows[2]!.id, betaRows[1]!.id],
      betaRows[2]!.id
    )
    const emit = vi.fn()
    const wake = vi.fn()
    const update = (participation: 'active' | 'paused') =>
      updateRoomParticipant(
        database!,
        agents[2]!.id,
        { participation },
        () => undefined,
        emit,
        wake
      )

    update('paused')

    expect(forParticipant(baseline, agents[2]!.id)).toMatchObject({
      state: 'suppressed',
      error: 'room_participant_paused',
      attempts: 0
    })
    for (const created of [baseline, first, second]) {
      for (const participant of agents.slice(0, 2)) {
        expect(forParticipant(created, participant.id)).toMatchObject({
          state: 'suppressed',
          error: 'room_stopped',
          nextAttemptAt: Number.MAX_SAFE_INTEGER
        })
      }
    }
    for (const participant of agents.slice(0, 2)) {
      expect(forParticipant(second, participant.id).queuePosition).toBeLessThan(
        forParticipant(first, participant.id).queuePosition!
      )
    }
    const deliveryEvents = emit.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.type === 'delivery.updated')
    expect(deliveryEvents).toHaveLength(5)

    update('active')
    database.messages.deliveries.resumeRoom(snapshot.room.id, 100)
    expect(forParticipant(baseline, agents[2]!.id)).toMatchObject({
      state: 'suppressed',
      error: 'room_participant_paused'
    })
    update('paused')
    expect(claimRoomBroadcastForTest(database, baseline.message.id)).toHaveLength(2)
  })

  it('does not let participant pause implicitly resume the room', () => {
    database = new RoomDatabase(':memory:')
    const snapshot = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const alpha = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'alpha',
      displayName: 'Alpha',
      agent: 'codex'
    })
    const beta = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'beta',
      displayName: 'Beta',
      agent: 'claude'
    })
    const create = (body: string, participantId: string) =>
      database!.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0].id,
        senderIdentity: snapshot.participants[0].identity,
        actorKind: 'user',
        body,
        targetParticipantIds: [participantId]
      }).deliveries[0]!
    const failed = create('Retry later', beta.id)
    database.messages.deliveries.claim(failed.id)
    database.messages.deliveries.complete(
      failed.id,
      'failed',
      'temporary_failure',
      Number.MAX_SAFE_INTEGER
    )
    const stopped = create('Stay paused', alpha.id)
    database.transaction(() => database!.messages.deliveries.stopRoom(snapshot.room.id))
    database.messages.deliveries.retry(failed.id, 100)

    updateRoomParticipant(
      database,
      alpha.id,
      { participation: 'paused' },
      () => undefined,
      vi.fn(),
      vi.fn()
    )

    expect(database.messages.deliveries.get(stopped.id)).toMatchObject({
      state: 'suppressed',
      error: 'room_participant_paused'
    })
    expect(database.messages.deliveries.workState(snapshot.room.id)).toBe('stopped')
    expect(database.messages.deliveries.listDue(100)).toEqual([])
    expect(database.messages.deliveries.claim(failed.id)).toBeNull()

    database.transaction(() => database!.messages.deliveries.resumeRoom(snapshot.room.id, 100))
    expect(database.messages.deliveries.listDue(100).map(({ id }) => id)).toContain(failed.id)
  })

  it('fences a confirmed retry while paused and resumes it when participation returns', () => {
    database = new RoomDatabase(':memory:')
    const snapshot = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const alpha = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'alpha',
      displayName: 'Alpha',
      agent: 'codex'
    })
    const beta = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'beta',
      displayName: 'Beta',
      agent: 'claude'
    })
    const delivery = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'Retry me',
      targetParticipantIds: [beta.id]
    }).deliveries[0]!
    database.messages.deliveries.claim(delivery.id)
    database.messages.deliveries.complete(
      delivery.id,
      'failed',
      'temporary_failure',
      Number.MAX_SAFE_INTEGER
    )
    const emit = vi.fn()
    const wake = vi.fn()
    const participation = (value: 'active' | 'paused') =>
      updateRoomParticipant(
        database!,
        beta.id,
        { participation: value },
        () => undefined,
        emit,
        wake
      )

    participation('paused')
    const failed = database.messages.deliveries.get(delivery.id)
    expect(emit.mock.calls.map(([, event]) => event.type)).toEqual([
      'participant.updated',
      'room.updated'
    ])
    expect(wake).toHaveBeenCalledOnce()
    expect(database.messages.listQueued(snapshot.room.id).deliveries.map(({ id }) => id)).toContain(
      delivery.id
    )
    expect(() => database!.messages.deliveries.retry(delivery.id, 100)).toThrow(
      'room_delivery_target_invalid'
    )
    expect(database.messages.deliveries.get(delivery.id)).toEqual(failed)

    participation('active')
    database.messages.deliveries.retry(delivery.id, 100)
    emit.mockClear()
    wake.mockClear()
    participation('paused')
    expect(database.messages.deliveries.get(delivery.id)).toMatchObject({
      state: 'pending',
      attempts: 1
    })
    expect(database.messages.deliveries.workState(snapshot.room.id)).toBe('idle')
    expect(database.messages.deliveries.listDue(100)).toEqual([])
    expect(database.messages.deliveries.nextDueAt()).toBeNull()
    expect(database.messages.deliveries.claim(delivery.id)).toBeNull()
    expect(emit.mock.calls.map(([, event]) => event.type)).toEqual([
      'participant.updated',
      'room.updated'
    ])
    expect(wake).toHaveBeenCalledOnce()

    const active = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'Other active work',
      targetParticipantIds: [alpha.id]
    }).deliveries[0]!
    database.messages.deliveries.claim(active.id)
    const stopped = database.messages.deliveries.stopRoom(snapshot.room.id)
    database.messages.deliveries.finishRoomStop(stopped.stopped.map(({ id }) => id))
    expect(database.messages.deliveries.get(delivery.id).error).toBe('room_stopped')
    const resumed = database.messages.deliveries.resumeRoom(snapshot.room.id, 100)
    expect(resumed.resumed.map(({ id }) => id)).not.toContain(delivery.id)
    expect(database.messages.deliveries.get(delivery.id)).toMatchObject({
      state: 'pending',
      attempts: 1,
      error: null
    })
    expect(database.messages.deliveries.listDue(100).map(({ id }) => id)).not.toContain(delivery.id)

    emit.mockClear()
    wake.mockClear()
    participation('active')
    expect(database.messages.deliveries.workState(snapshot.room.id)).toBe('active')
    expect(database.messages.deliveries.listDue(100).map(({ id }) => id)).toContain(delivery.id)
    expect(emit.mock.calls.map(([, event]) => event.type)).toEqual([
      'participant.updated',
      'room.updated'
    ])
    expect(wake).toHaveBeenCalledOnce()
  })
})
