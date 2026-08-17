import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomDatabase } from './database'
import type { RoomAttachmentManager } from './attachments'
import { claimRoomBroadcastForTest } from './delivery-test-claim'
import { RoomMessageController } from './message-controller'
import { updateRoomParticipant } from './participant-participation'

describe('room delivery queues', () => {
  let database: RoomDatabase | undefined

  afterEach(() => database?.close())

  const setup = () => {
    database = new RoomDatabase(':memory:')
    const snapshot = database.createRoom({ projectId: 'project-1', name: 'Research' })
    const codex = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex'
    })
    const create = (body: string) =>
      database!.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0].id,
        senderIdentity: snapshot.participants[0].identity,
        actorKind: 'user',
        body,
        targetParticipantIds: [codex.id]
      })
    return { database, snapshot, codex, create }
  }

  it('targets and reorders independent participant delivery queues', () => {
    const { database, snapshot, codex, create } = setup()
    const claude = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const first = create('first')
    const second = create('second')

    expect(first.deliveries.map(({ participantId }) => participantId)).toEqual([codex.id])
    database.messages.deliveries.reorder(
      codex.id,
      [second.deliveries[0].id, first.deliveries[0].id],
      second.deliveries[0].id
    )
    expect(database.messages.deliveries.listDue().map(({ messageId }) => messageId)).toEqual([
      second.message.id
    ])

    expect(database.messages.deliveries.retarget(second.message.id, [claude.id])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ participantId: codex.id, state: 'suppressed' }),
        expect.objectContaining({ participantId: claude.id, state: 'pending' })
      ])
    )
    const restored = database.messages.deliveries.retarget(second.message.id, [codex.id, claude.id])
    expect(
      restored.find(({ participantId }) => participantId === codex.id)?.queuePosition
    ).toBeGreaterThan(first.deliveries[0].queuePosition ?? 0)
  })

  it('normalizes a directed message when it returns to the common queue', () => {
    const { database, snapshot, codex, create } = setup()
    const claude = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const all = [codex.id, claude.id]
    const first = create('first')
    database.messages.deliveries.retarget(first.message.id, all)
    database.messages.deliveries.retarget(first.message.id, [codex.id])
    const second = create('second')
    database.messages.deliveries.retarget(second.message.id, all)

    const restored = database.messages.deliveries.retarget(first.message.id, all)
    for (const participantId of all) {
      const firstPosition = restored.find(
        (delivery) => delivery.participantId === participantId
      )!.queuePosition!
      const secondPosition = database.messages.deliveries
        .listForMessage(second.message.id)
        .find((delivery) => delivery.participantId === participantId)!.queuePosition!
      expect(firstPosition).toBeGreaterThan(secondPosition)
    }

    const stable = restored.map(({ id, queuePosition }) => ({ id, queuePosition }))
    expect(
      database.messages.deliveries
        .retarget(first.message.id, all)
        .map(({ id, queuePosition }) => ({ id, queuePosition }))
    ).toEqual(stable)
    expect(claimRoomBroadcastForTest(database, second.message.id)).toHaveLength(2)
  })

  it('preserves stopped state while directing a message to the common queue', () => {
    const { database, snapshot, codex, create } = setup()
    const claude = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const created = create('stopped')
    database.transaction(() => database.messages.deliveries.stopRoom(snapshot.room.id))

    const deliveries = database.messages.deliveries.retarget(created.message.id, [
      codex.id,
      claude.id
    ])

    expect(deliveries).toHaveLength(2)
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: codex.id,
          state: 'suppressed',
          error: 'room_stopped',
          nextAttemptAt: Number.MAX_SAFE_INTEGER
        }),
        expect.objectContaining({
          participantId: claude.id,
          state: 'suppressed',
          error: 'room_stopped',
          nextAttemptAt: Number.MAX_SAFE_INTEGER
        })
      ])
    )
    expect(new Set(deliveries.map((delivery) => delivery.queuePosition)).size).toBe(1)
  })

  it('claims only the current directed queue head', () => {
    const { database, snapshot, codex, create } = setup()
    database.participants.add({
      roomId: snapshot.room.id,
      identity: 'other',
      displayName: 'Other',
      agent: 'claude'
    })
    const first = create('first').deliveries[0]
    const second = create('second').deliveries[0]

    expect(database.messages.deliveries.listDue()[0]?.id).toBe(first.id)
    database.messages.deliveries.reorder(codex.id, [second.id, first.id], second.id)

    expect(database.messages.deliveries.claim(first.id)).toBeNull()
    expect(database.messages.deliveries.claim(second.id)).toMatchObject({
      state: 'delivering',
      attempts: 1
    })
    expect(database.messages.get(second.messageId).deliveryAttempted).toBe(true)
  })

  it('does not ordinarily claim a current initial broadcast', () => {
    const { database, create } = setup()
    const created = create('broadcast')

    expect(database.messages.deliveries.claim(created.deliveries[0].id)).toBeNull()
    expect(claimRoomBroadcastForTest(database, created.message.id)).toEqual([
      expect.objectContaining({ state: 'delivering', attempts: 1 })
    ])
    expect(database.messages.get(created.message.id).deliveryAttempted).toBe(true)
  })

  it('does not claim directed work for a paused participant', () => {
    const { database, snapshot, codex, create } = setup()
    database.participants.add({
      roomId: snapshot.room.id,
      identity: 'other',
      displayName: 'Other',
      agent: 'claude'
    })
    const delivery = create('paused target').deliveries[0]
    database.participants.update(codex.id, { participation: 'paused' })

    expect(database.messages.deliveries.claim(delivery.id)).toBeNull()
    expect(database.messages.deliveries.claimSteer(delivery.id)).toBeNull()
  })

  it('settles every delivery steered into the same provider turn', () => {
    const { database, snapshot, codex, create } = setup()
    database.participants.add({
      roomId: snapshot.room.id,
      identity: 'other',
      displayName: 'Other',
      agent: 'claude'
    })
    const first = create('first')
    const second = create('steer')
    database.messages.deliveries.claim(first.deliveries[0].id)
    database.messages.deliveries.confirmTurn(first.deliveries[0].id, 'turn-1', 10)
    database.messages.deliveries.claimSteer(second.deliveries[0].id)
    database.messages.deliveries.confirmTurn(second.deliveries[0].id, 'turn-1', 10)

    const reply = database.providerMessages.createReply({
      participant: codex,
      delivery: database.messages.deliveries.get(second.deliveries[0].id),
      providerSessionId: 'session-1',
      providerMessageId: 'answer-1',
      body: 'done',
      mentions: [],
      createdAt: 20
    })

    expect(reply?.replyToId).toBe(second.message.id)
    expect(
      database.messages.deliveries
        .listForTurn(codex.id, 'turn-1')
        .every((delivery) => delivery.respondedAt === 20)
    ).toBe(true)
  })

  it('claims explicit steer as a sticky attempt and returns it to the head', () => {
    const { database, snapshot, codex, create } = setup()
    database.participants.add({
      roomId: snapshot.room.id,
      identity: 'other',
      displayName: 'Other',
      agent: 'claude'
    })
    const first = create('first').deliveries[0]
    const steered = create('steer').deliveries[0]

    expect(database.messages.deliveries.claimSteer(steered.id)).toMatchObject({
      intent: 'steer',
      attempts: 1,
      state: 'delivering'
    })
    expect(database.messages.get(steered.messageId).deliveryAttempted).toBe(true)
    expect(database.messages.deliveries.listDue()).toEqual([])
    const returned = database.messages.deliveries.returnSteerToNext(steered.id, 'stale')
    expect(returned).toMatchObject({ intent: 'next', attempts: 1, state: 'pending' })
    expect(returned.queuePosition).toBeLessThan(first.queuePosition ?? 0)
    expect(database.messages.deliveries.listDue()[0].participantId).toBe(codex.id)
    expect(() => database.messages.deliveries.assertMessageMutable(steered.messageId)).toThrow(
      'room_delivery_queue_stale'
    )
    expect(database.messages.deliveries.claim(steered.id)).toMatchObject({
      intent: 'next',
      attempts: 2,
      state: 'delivering'
    })
  })

  it('keeps only the latest five delivery attempt diagnostics', () => {
    const { database, create } = setup()
    const delivery = create('inspect this').deliveries[0]

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      if (attempt === 1) {
        claimRoomBroadcastForTest(database, delivery.messageId)
      } else {
        database.messages.deliveries.claim(delivery.id)
      }
      database.messages.deliveries.setPhase(delivery.id, 'submitting')
      database.messages.deliveries.complete(delivery.id, 'pending', `failure-${attempt}`, attempt)
    }

    expect(database.messages.deliveries.get(delivery.id).attemptHistory).toMatchObject([
      { attempt: 2, error: 'failure-2' },
      { attempt: 3, error: 'failure-3' },
      { attempt: 4, error: 'failure-4' },
      { attempt: 5, error: 'failure-5' },
      { attempt: 6, error: 'failure-6' }
    ])
  })

  it('resumes stopped mixed steer as sticky next deliveries', () => {
    const { database, snapshot, codex } = setup()
    const beta = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'beta',
      displayName: 'Beta',
      agent: 'codex'
    })
    const gamma = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'gamma',
      displayName: 'Gamma',
      agent: 'codex'
    })
    const targets = [codex, beta, gamma].map((participant) =>
      database.participants.update(participant.id, {
        worktreeId: `worktree-${participant.identity}`,
        providerSession: {
          key: 'session_id',
          id: `session-${participant.identity}`,
          transport: 'machine'
        }
      })
    )
    const created = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'shared steer'
    })
    const fingerprints = targets.map((participant) => ({
      participantId: participant.id,
      state: participant.state,
      processIncarnation: participant.processIncarnation,
      worktreeId: participant.worktreeId!,
      providerSessionKey: participant.providerSession!.key,
      providerSessionId: participant.providerSession!.id
    }))
    expect(
      database.messages.deliveries.claimBroadcastSteer(
        created.message.id,
        [fingerprints[0]!, fingerprints[0]!, fingerprints[2]!],
        [codex.id, gamma.id]
      )
    ).toBeNull()
    expect(
      database.messages.deliveries.claimBroadcastSteer(created.message.id, fingerprints, [
        codex.id,
        gamma.id
      ])
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ participantId: codex.id, intent: 'steer', attempts: 1 }),
        expect.objectContaining({ participantId: beta.id, intent: 'next', attempts: 1 }),
        expect.objectContaining({ participantId: gamma.id, intent: 'steer', attempts: 1 })
      ])
    )
    expect(database.messages.get(created.message.id).deliveryAttempted).toBe(true)
    const rejected = created.deliveries.find((delivery) => delivery.participantId === codex.id)!
    expect(database.messages.deliveries.returnSteerToNext(rejected.id, 'rejected')).toMatchObject({
      state: 'pending',
      intent: 'next',
      attempts: 1
    })
    expect(() => database.messages.deliveries.assertMessageMutable(created.message.id)).toThrow(
      'room_delivery_queue_stale'
    )

    const stopped = database.messages.deliveries.stopRoom(snapshot.room.id)
    database.messages.deliveries.finishRoomStop(stopped.stopped.map((delivery) => delivery.id))
    database.participants.update(gamma.id, { participation: 'paused' })
    const resumed = database.messages.deliveries.resumeRoom(snapshot.room.id, 100)

    expect(resumed.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: codex.id,
          state: 'pending',
          intent: 'next',
          attempts: 1
        }),
        expect.objectContaining({
          participantId: beta.id,
          state: 'pending',
          intent: 'next',
          attempts: 1
        }),
        expect.objectContaining({
          participantId: gamma.id,
          state: 'pending',
          error: null,
          intent: 'next',
          attempts: 1
        })
      ])
    )
    expect(
      database.messages.deliveries.listDue(100).map((delivery) => delivery.participantId)
    ).toEqual(expect.arrayContaining([codex.id, beta.id]))
    expect(() => database.messages.deliveries.assertMessageMutable(created.message.id)).toThrow(
      'room_delivery_queue_stale'
    )
  })

  it('reorders the common queue transactionally and rejects mutation after delivery begins', () => {
    const { database, snapshot, codex, create } = setup()
    const claude = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const first = create('first')
    database.messages.deliveries.retarget(first.message.id, [codex.id, claude.id])
    const second = create('second')
    database.messages.deliveries.retarget(second.message.id, [codex.id, claude.id])

    const original = [first, second].flatMap(({ deliveries }) =>
      deliveries.map(({ id }) => database.messages.deliveries.get(id).queuePosition)
    )
    expect(() =>
      database.messages.deliveries.reorderAll(snapshot.room.id, [
        second.message.id,
        first.message.id
      ])
    ).toThrow('room_delivery_queue_stale')
    expect(
      [first, second].flatMap(({ deliveries }) =>
        deliveries.map(({ id }) => database.messages.deliveries.get(id).queuePosition)
      )
    ).toEqual(original)
    database.messages.deliveries.reorderAll(
      snapshot.room.id,
      [second.message.id, first.message.id],
      second.message.id
    )
    for (const participant of [codex, claude]) {
      expect(
        database.messages.deliveries
          .listForMessage(second.message.id)
          .find((delivery) => delivery.participantId === participant.id)!.queuePosition
      ).toBeLessThan(
        database.messages.deliveries
          .listForMessage(first.message.id)
          .find((delivery) => delivery.participantId === participant.id)!.queuePosition!
      )
    }

    claimRoomBroadcastForTest(database, second.message.id)
    expect(() => database.messages.deliveries.assertMessageMutable(second.message.id)).toThrow(
      'room_delivery_queue_stale'
    )
  })

  it('reorders only active queues while preserving a paused retry', () => {
    const { database, snapshot, codex, create } = setup()
    const claude = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const attempted = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'attempted shared'
    })
    const claimed = claimRoomBroadcastForTest(database, attempted.message.id)!
    const codexAttempt = claimed.find((delivery) => delivery.participantId === codex.id)!
    const claudeRetry = claimed.find((delivery) => delivery.participantId === claude.id)!
    database.messages.deliveries.complete(codexAttempt.id, 'delivered', null)
    database.messages.deliveries.markResponded(codexAttempt.id, null, 10)
    database.messages.deliveries.complete(claudeRetry.id, 'pending', 'send_failed', 10)
    updateRoomParticipant(
      database,
      claude.id,
      { participation: 'paused' },
      () => {},
      () => {},
      () => {}
    )
    const pausedPosition = database.messages.deliveries.get(claudeRetry.id).queuePosition
    const first = create('first active')
    const second = create('second active')

    const reordered = database.messages.deliveries.reorderAll(
      snapshot.room.id,
      [second.message.id, first.message.id],
      second.message.id
    )

    expect(reordered.every((delivery) => delivery.participantId === codex.id)).toBe(true)
    expect(database.messages.deliveries.get(second.deliveries[0]!.id).queuePosition).toBeLessThan(
      database.messages.deliveries.get(first.deliveries[0]!.id).queuePosition!
    )
    expect(database.messages.deliveries.get(claudeRetry.id)).toMatchObject({
      state: 'pending',
      attempts: 1,
      queuePosition: pausedPosition
    })

    updateRoomParticipant(
      database,
      claude.id,
      { participation: 'active' },
      () => {},
      () => {},
      () => {}
    )
    expect(database.messages.deliveries.get(claudeRetry.id)).toMatchObject({
      state: 'pending',
      queuePosition: pausedPosition
    })
  })

  it('rejects markerless participant reorder before broadcast queues diverge', () => {
    const { database, snapshot, codex, create } = setup()
    const claude = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const targets = [codex.id, claude.id]
    const first = create('first')
    database.messages.deliveries.retarget(first.message.id, targets)
    const second = create('second')
    database.messages.deliveries.retarget(second.message.id, targets)
    const codexRows = [first, second].map(({ message }) =>
      database.messages.deliveries
        .listForMessage(message.id)
        .find((delivery) => delivery.participantId === codex.id)!
    )

    expect(() =>
      database.messages.deliveries.reorder(codex.id, [codexRows[1]!.id, codexRows[0]!.id])
    ).toThrow('room_delivery_queue_stale')
    expect(claimRoomBroadcastForTest(database, first.message.id)).toHaveLength(2)
  })

  it('rejects stale and markerless participant reorder without mutation', () => {
    const { database, codex, create } = setup()
    const first = create('first').deliveries[0]
    const second = create('second').deliveries[0]
    const claimed = claimRoomBroadcastForTest(database, first.messageId)![0]!
    database.messages.deliveries.complete(claimed.id, 'pending', 'send_failed', 100)

    expect(() =>
      database.messages.deliveries.reorder(codex.id, [second.id, first.id], first.id)
    ).toThrow('room_delivery_queue_stale')
    database.messages.deliveries.reorderAll(
      database.messages.get(second.messageId).roomId,
      [second.messageId, first.messageId],
      second.messageId
    )
    const positions = [first.id, second.id].map(
      (id) => database.messages.deliveries.get(id).queuePosition
    )
    expect(() => database.messages.deliveries.reorder(codex.id, [first.id, second.id])).toThrow(
      'room_delivery_queue_stale'
    )
    expect(
      [first.id, second.id].map((id) => database.messages.deliveries.get(id).queuePosition)
    ).toEqual(positions)
  })

  it('accepts only the declared single-message move', () => {
    const { database, snapshot, create } = setup()
    const first = create('first')
    const second = create('second')
    const third = create('third')

    expect(() =>
      database.messages.deliveries.reorderAll(
        snapshot.room.id,
        [third.message.id, second.message.id, first.message.id],
        third.message.id
      )
    ).toThrow('room_delivery_queue_stale')
    expect(() =>
      database.messages.deliveries.reorderAll(
        snapshot.room.id,
        [third.message.id, first.message.id, second.message.id],
        third.message.id
      )
    ).not.toThrow()
  })

  it('rejects a moved message when any sibling delivery was attempted', () => {
    const { database, snapshot, create } = setup()
    database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const first = create('first')
    database.messages.deliveries.retarget(
      first.message.id,
      database.participants
        .list(snapshot.room.id)
        .filter((participant) => participant.actorKind === 'agent')
        .map((participant) => participant.id)
    )
    const second = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'second'
    })
    const claimed = claimRoomBroadcastForTest(database, first.message.id)![0]!
    database.messages.deliveries.complete(claimed.id, 'pending', 'send_failed', 100)

    expect(() =>
      database.messages.deliveries.reorderAll(
        snapshot.room.id,
        [second.message.id, first.message.id],
        first.message.id
      )
    ).toThrow('room_delivery_queue_stale')
  })

  it('keeps failed deliveries in the actionable queue projection', () => {
    const { database, snapshot, create } = setup()
    const created = create('uncertain')
    const delivery = claimRoomBroadcastForTest(database, created.message.id)![0]!
    database.messages.deliveries.complete(
      delivery.id,
      'failed',
      'room_delivery_uncertain',
      Number.MAX_SAFE_INTEGER
    )

    expect(database.messages.listQueued(snapshot.room.id)).toMatchObject({
      messages: [expect.objectContaining({ id: created.message.id })],
      deliveries: [expect.objectContaining({ id: delivery.id, state: 'failed' })]
    })
  })

  it('claims a broadcast only as one queue-head group', () => {
    const { database, snapshot, codex } = setup()
    const claude = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const blocker = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'blocker',
      targetParticipantIds: [codex.id]
    })
    const broadcast = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'broadcast'
    })

    expect(claimRoomBroadcastForTest(database, broadcast.message.id)).toBeNull()
    database.messages.deliveries.retarget(blocker.message.id, [])
    const claimed = claimRoomBroadcastForTest(database, broadcast.message.id)
    expect(claimed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ participantId: codex.id, state: 'delivering', attempts: 1 }),
        expect.objectContaining({ participantId: claude.id, state: 'delivering', attempts: 1 })
      ])
    )
  })

  it('uses common-queue dispatch and placement with one active participant', () => {
    const { database, codex, create } = setup()
    const first = create('first')
    const second = create('second')

    expect(database.messages.deliveries.isBroadcastMessage(first.message.id)).toBe(true)
    expect(() =>
      database.messages.deliveries.reorder(
        codex.id,
        [second.deliveries[0].id, first.deliveries[0].id],
        undefined,
        second.message.id
      )
    ).not.toThrow()
    expect(claimRoomBroadcastForTest(database, second.message.id)).toEqual([
      expect.objectContaining({ participantId: codex.id, state: 'delivering', attempts: 1 })
    ])
  })

  it('keeps stopped unclaimed deliveries mutable until resume', () => {
    const { database, snapshot, codex, create } = setup()
    const created = create('paused')
    database.messages.deliveries.stopRoom(snapshot.room.id)

    expect(() =>
      database.messages.deliveries.assertMessageMutable(created.message.id)
    ).not.toThrow()
    database.messages.deliveries.retarget(created.message.id, [codex.id])
    expect(database.messages.listQueued(snapshot.room.id).deliveries[0]).toMatchObject({
      state: 'suppressed',
      error: 'room_stopped'
    })
  })

  it('keeps a never-claimed message without deliveries mutable', () => {
    const { database, snapshot } = setup()
    const created = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'history only',
      enqueueDeliveries: false
    })

    expect(created.deliveries).toEqual([])
    expect(() =>
      database.messages.deliveries.assertMessageMutable(created.message.id)
    ).not.toThrow()
  })

  it('removes one target using the current backend target set', () => {
    const { database, snapshot, codex, create } = setup()
    const claude = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const created = create('directed')
    database.messages.deliveries.retarget(created.message.id, [codex.id, claude.id])
    const controller = new RoomMessageController(
      database,
      {} as RoomAttachmentManager,
      () => undefined,
      () => undefined
    )

    expect(
      controller.removeTarget(created.message.id, snapshot.participants[0].identity, codex.id)
    ).toBe(false)
    expect(database.messages.deliveries.listForMessage(created.message.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ participantId: codex.id, state: 'suppressed' }),
        expect.objectContaining({ participantId: claude.id, state: 'pending' })
      ])
    )

    const last = create('last target')
    expect(
      controller.removeTarget(last.message.id, snapshot.participants[0].identity, codex.id)
    ).toBe(true)
  })

  it('retargets and places a broadcast atomically in one participant queue', () => {
    const { database, snapshot, codex, create } = setup()
    const claude = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const first = create('first')
    const shared = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'shared'
    })
    const codexShared = shared.deliveries.find((delivery) => delivery.participantId === codex.id)!

    const emit = vi.fn()
    const controller = new RoomMessageController(
      database,
      {} as RoomAttachmentManager,
      emit,
      () => undefined
    )
    controller.reorder(
      codex.id,
      [codexShared.id, first.deliveries[0].id],
      undefined,
      shared.message.id
    )
    expect(database.messages.deliveries.listForMessage(shared.message.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ participantId: codex.id, state: 'pending' }),
        expect.objectContaining({ participantId: claude.id, state: 'suppressed' })
      ])
    )
    expect(
      emit.mock.calls
        .filter(([, event]) => event.type === 'delivery.updated')
        .map(([, event]) => event.delivery.id)
    ).toEqual(expect.arrayContaining(shared.deliveries.map((delivery) => delivery.id)))
    expect(() =>
      database.messages.deliveries.reorder(
        codex.id,
        [first.deliveries[0].id, codexShared.id],
        codexShared.id
      )
    ).not.toThrow()
  })

  it('rejects conflicting participant reorder markers before mutation', () => {
    const { database, snapshot, codex, create } = setup()
    database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const directed = create('directed').deliveries[0]
    const shared = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'shared'
    })
    const sharedDelivery = shared.deliveries.find(
      (delivery) => delivery.participantId === codex.id
    )!
    const before = [directed.id, sharedDelivery.id].map(
      (id) => database.messages.deliveries.get(id).queuePosition
    )

    expect(() =>
      database.messages.deliveries.reorder(
        codex.id,
        [sharedDelivery.id, directed.id],
        sharedDelivery.id,
        shared.message.id
      )
    ).toThrow('room_delivery_queue_stale')
    expect(
      [directed.id, sharedDelivery.id].map(
        (id) => database.messages.deliveries.get(id).queuePosition
      )
    ).toEqual(before)
  })

  it('rejects direct-and-place requests that reorder more than the moved message', () => {
    const { database, snapshot, codex, create } = setup()
    database.participants.add({
      roomId: snapshot.room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude'
    })
    const first = create('first').deliveries[0]
    const second = create('second').deliveries[0]
    const shared = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'shared'
    })
    const moved = shared.deliveries.find((delivery) => delivery.participantId === codex.id)!

    expect(() =>
      database.messages.deliveries.reorder(
        codex.id,
        [moved.id, second.id, first.id],
        undefined,
        shared.message.id
      )
    ).toThrow('room_delivery_queue_stale')
    expect(database.messages.deliveries.isBroadcastMessage(shared.message.id)).toBe(true)
  })
})
