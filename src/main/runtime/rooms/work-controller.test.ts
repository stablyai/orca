import { describe, expect, it, vi } from 'vitest'
import { RoomDatabase } from './database'
import type { RoomHarnessRuntime } from './harness-adapter'
import { RoomService } from './service'
import { RoomWorkController } from './work-controller'
import type { RoomDeliveryWorker } from './delivery-worker'
import type { RoomTranscriptBridge } from './transcript-bridge'
import { claimRoomBroadcastForTest } from './delivery-test-claim'

describe('room work control', () => {
  it('resumes a manual room stop before the latest loop-limit wave', () => {
    const database = new RoomDatabase(':memory:')
    const snapshot = database.createRoom({
      projectId: 'project-1',
      name: 'Research',
      userIdentity: 'egor'
    })
    database.participants.add({
      roomId: snapshot.room.id,
      identity: 'alpha',
      displayName: 'Alpha',
      agent: 'codex'
    })
    const first = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: 'egor',
      actorKind: 'user',
      body: 'Stopped manually'
    })
    const beta = database.participants.add({
      roomId: snapshot.room.id,
      identity: 'beta',
      displayName: 'Beta',
      agent: 'claude'
    })
    const second = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: 'egor',
      actorKind: 'user',
      body: 'Stopped by the loop limit',
      targetParticipantIds: [beta.id]
    })
    const loopDelivery = second.deliveries[0]
    database.messages.deliveries.claim(loopDelivery.id)
    database.messages.deliveries.complete(
      loopDelivery.id,
      'suppressed',
      null,
      Number.MAX_SAFE_INTEGER
    )
    database.transaction(() => database.messages.deliveries.stopRoom(snapshot.room.id))

    expect(database.messages.deliveries.resumeRoom(snapshot.room.id, 100).resumed).toMatchObject([
      { id: first.deliveries[0].id, state: 'pending' }
    ])
    expect(database.messages.deliveries.get(loopDelivery.id)).toMatchObject({
      state: 'suppressed',
      error: null
    })

    const manualDelivery = first.deliveries[0]
    database.messages.deliveries.claim(manualDelivery.id)
    database.messages.deliveries.confirmTurn(manualDelivery.id, 'turn-alpha', 101)
    database.messages.deliveries.markResponded(manualDelivery.id, null, 102)
    expect(database.messages.deliveries.resumeRoom(snapshot.room.id, 103).resumed).toMatchObject([
      { id: loopDelivery.id, state: 'pending' }
    ])
    database.close()
  })

  it('keeps a paused room stopped when an earlier failed delivery is retried', () => {
    const database = new RoomDatabase(':memory:')
    const snapshot = database.createRoom({ projectId: 'project-1', name: 'Research' })
    database.participants.add({
      roomId: snapshot.room.id,
      identity: 'alpha',
      displayName: 'Alpha',
      agent: 'codex'
    })
    const failed = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'Retry later'
    }).deliveries[0]!
    claimRoomBroadcastForTest(database, failed.messageId)
    database.messages.deliveries.complete(
      failed.id,
      'failed',
      'temporary_failure',
      Number.MAX_SAFE_INTEGER
    )
    const queued = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'Stay paused'
    }).deliveries[0]!

    database.messages.deliveries.stopRoom(snapshot.room.id)
    database.messages.deliveries.retry(failed.id)

    expect(database.messages.deliveries.get(failed.id).state).toBe('pending')
    expect(database.messages.deliveries.get(queued.id).error).toBe('room_stopped')
    expect(database.messages.deliveries.workState(snapshot.room.id)).toBe('stopped')
    database.close()
  })

  it('keeps retries fenced until an unfinished Stop completes and resumes', () => {
    const database = new RoomDatabase(':memory:')
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
      database.messages.create({
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
    const stopping = create('Stop this', alpha.id)
    database.messages.deliveries.claim(stopping.id)

    database.messages.deliveries.stopRoom(snapshot.room.id)
    database.messages.deliveries.retry(failed.id, 100)

    expect(database.messages.deliveries.workState(snapshot.room.id)).toBe('active')
    expect(database.messages.deliveries.listDue(100)).toEqual([])
    expect(database.messages.deliveries.nextDueAt()).toBeNull()
    expect(database.messages.deliveries.claim(failed.id)).toBeNull()
    expect(database.messages.deliveries.claimSteer(failed.id)).toBeNull()

    database.messages.deliveries.finishRoomStop([stopping.id])
    expect(database.messages.deliveries.workState(snapshot.room.id)).toBe('stopped')
    expect(database.messages.deliveries.listDue(100)).toEqual([])

    database.messages.deliveries.resumeRoom(snapshot.room.id, 100)
    expect(database.messages.deliveries.listDue(100).map(({ id }) => id)).toEqual(
      expect.arrayContaining([failed.id, stopping.id])
    )
    database.close()
  })

  it('resumes only active participants and seals paused stopped deliveries', async () => {
    const database = new RoomDatabase(':memory:')
    const emit = vi.fn()
    const wake = vi.fn()
    const controller = new RoomWorkController(
      database,
      { wake } as unknown as RoomDeliveryWorker,
      {} as RoomTranscriptBridge,
      {},
      emit
    )
    const createStoppedRoom = (name: string, identities: string[]) => {
      const snapshot = database.createRoom({ projectId: `project-${name}`, name })
      const participants = identities.map((identity) =>
        database.participants.add({
          roomId: snapshot.room.id,
          identity,
          displayName: identity,
          agent: 'codex'
        })
      )
      const created = database.messages.create({
        roomId: snapshot.room.id,
        senderId: snapshot.participants[0].id,
        senderIdentity: snapshot.participants[0].identity,
        actorKind: 'user',
        body: 'queued'
      })
      database.transaction(() => database.messages.deliveries.stopRoom(snapshot.room.id))
      return { snapshot, participants, created }
    }

    try {
      const mixed = createStoppedRoom('mixed', ['alpha', 'beta'])
      database.participants.update(mixed.participants[1]!.id, { participation: 'paused' })

      await expect(controller.resume(mixed.snapshot.room.id)).resolves.toBe(1)
      const deliveries = mixed.created.deliveries.map((delivery) =>
        database.messages.deliveries.get(delivery.id)
      )
      expect(deliveries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            participantId: mixed.participants[0]!.id,
            state: 'pending',
            attempts: 0
          }),
          expect.objectContaining({
            participantId: mixed.participants[1]!.id,
            state: 'suppressed',
            error: 'room_participant_paused',
            attempts: 0
          })
        ])
      )
      expect(emit).toHaveBeenCalledTimes(3)
      expect(wake).toHaveBeenCalledOnce()
      expect(() =>
        database.messages.deliveries.assertMessageMutable(mixed.created.message.id)
      ).not.toThrow()

      const pausedDelivery = deliveries.find(
        (delivery) => delivery.participantId === mixed.participants[1]!.id
      )!
      database.participants.update(mixed.participants[1]!.id, { participation: 'active' })
      expect(database.messages.deliveries.get(pausedDelivery.id)).toMatchObject({
        state: 'suppressed',
        error: 'room_participant_paused'
      })
      database.messages.deliveries.retarget(
        mixed.created.message.id,
        mixed.participants.map((participant) => participant.id)
      )
      expect(database.messages.deliveries.get(pausedDelivery.id).state).toBe('pending')

      emit.mockClear()
      wake.mockClear()
      const paused = createStoppedRoom('paused', ['gamma'])
      database.participants.update(paused.participants[0]!.id, { participation: 'paused' })
      await expect(controller.resume(paused.snapshot.room.id)).resolves.toBe(0)
      expect(database.messages.deliveries.get(paused.created.deliveries[0]!.id)).toMatchObject({
        state: 'suppressed',
        error: 'room_participant_paused'
      })
      expect(database.messages.deliveries.workState(paused.snapshot.room.id)).toBe('idle')
      expect(emit).toHaveBeenCalledTimes(2)
      expect(wake).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it('stops an already-idle agent without waiting for new PTY output', async () => {
    const unused = async (): Promise<never> => {
      throw new Error('unused')
    }
    const runtime: RoomHarnessRuntime = {
      createAgentSession: unused,
      ensureAgentSession: unused,
      sendTerminalAgentPrompt: unused,
      sendTerminal: async (handle, action) => ({
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(action.text ?? '')
      }),
      waitForTerminalAgentInputReady: unused,
      compactTerminalAgentSession: unused,
      getTerminalAgentStatus: unused,
      getTerminalProcessIncarnation: () => null,
      closeTerminal: unused,
      waitForTerminal: async (handle) => ({
        handle,
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      }),
      listRoomRunningAgents: async () => [],
      listRoomExistingAgents: async () => [],
      resolveRoomHistoricalSession: unused,
      stageRoomAttachment: unused
    }
    const service = new RoomService(':memory:', runtime)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const agent = service.db.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:codex',
      terminalHandle: 'term-codex',
      providerSession: { key: 'session_id', id: 'session-codex' }
    })
    const delivery = service.db.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'Review this'
    }).deliveries[0]!
    claimRoomBroadcastForTest(service.db, delivery.messageId)
    service.db.messages.deliveries.confirmTurn(delivery.id, 'turn-codex')
    try {
      await service.stopRoom(snapshot.room.id)
      expect(service.db.messages.deliveries.get(delivery.id)).toMatchObject({
        state: 'suppressed',
        error: 'room_stopped',
        participantId: agent.id
      })
      expect(service.snapshot(snapshot.room.id).workState).toBe('stopped')
    } finally {
      service.close()
    }
  })

  it('finishes a stale stop for a sleeping participant without touching its archived handle', async () => {
    const unused = async (): Promise<never> => {
      throw new Error('unused')
    }
    const sendTerminal = vi.fn(unused)
    const runtime: RoomHarnessRuntime = {
      createAgentSession: unused,
      ensureAgentSession: unused,
      sendTerminalAgentPrompt: unused,
      sendTerminal,
      waitForTerminalAgentInputReady: unused,
      compactTerminalAgentSession: unused,
      getTerminalAgentStatus: unused,
      getTerminalProcessIncarnation: () => null,
      closeTerminal: unused,
      waitForTerminal: unused,
      listRoomRunningAgents: async () => [],
      listRoomExistingAgents: async () => [],
      resolveRoomHistoricalSession: unused,
      stageRoomAttachment: unused
    }
    const service = new RoomService(':memory:', runtime)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const added = service.db.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:codex',
      terminalHandle: 'term-stale',
      providerSession: { key: 'session_id', id: 'session-codex' }
    })
    const participant = service.db.participants.update(added.id, { state: 'sleeping' })
    const delivery = service.db.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'Review this'
    }).deliveries[0]!
    claimRoomBroadcastForTest(service.db, delivery.messageId)
    service.db.messages.deliveries.confirmTurn(delivery.id, 'turn-codex')

    try {
      await expect(service.stopRoom(snapshot.room.id)).resolves.toBe(1)
      expect(service.db.messages.deliveries.get(delivery.id)).toMatchObject({
        participantId: participant.id,
        state: 'suppressed',
        error: 'room_stopped'
      })
      expect(sendTerminal).not.toHaveBeenCalled()
    } finally {
      service.close()
    }
  })

  it('suppresses a message delivery before soft-deleting its payload', async () => {
    const unused = async (): Promise<never> => {
      throw new Error('unused')
    }
    const runtime: RoomHarnessRuntime = {
      createAgentSession: unused,
      ensureAgentSession: unused,
      sendTerminalAgentPrompt: unused,
      waitForTerminalAgentInputReady: async () => true,
      compactTerminalAgentSession: unused,
      getTerminalAgentStatus: unused,
      getTerminalProcessIncarnation: () => null,
      closeTerminal: unused,
      waitForTerminal: async (handle) => ({
        handle,
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      }),
      listRoomRunningAgents: async () => [],
      listRoomExistingAgents: async () => [],
      resolveRoomHistoricalSession: unused,
      stageRoomAttachment: unused
    }
    const service = new RoomService(':memory:', runtime)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    service.db.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex'
    })
    const created = service.db.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'Delete me'
    })
    try {
      await service.deleteMessage(created.message.id, snapshot.participants[0].identity)

      expect(service.db.messages.get(created.message.id)).toMatchObject({
        body: '',
        deletedAt: expect.any(Number)
      })
      expect(service.db.messages.deliveries.get(created.deliveries[0].id)).toMatchObject({
        state: 'suppressed',
        error: 'room_message_deleted'
      })
    } finally {
      service.close()
    }
  })

  it('interrupts an in-flight prompt before waiting for its cleanup', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const order: string[] = []
    const unused = async (): Promise<never> => {
      throw new Error('unused')
    }
    const runtime: RoomHarnessRuntime = {
      createAgentSession: unused,
      ensureAgentSession: unused,
      sendTerminalAgentPrompt: async (_handle, _prompt, options) => {
        order.push('send')
        await gate
        try {
          await options?.beforeWrite?.('pty-codex')
        } finally {
          order.push('cleanup')
        }
        return { handle: 'term-codex', accepted: true, bytesWritten: 1 }
      },
      sendTerminal: async (handle, action) => {
        order.push('esc')
        return { handle, accepted: true, bytesWritten: Buffer.byteLength(action.text ?? '') }
      },
      waitForTerminalAgentInputReady: async () => true,
      compactTerminalAgentSession: unused,
      getTerminalAgentStatus: async (handle) => ({
        handle,
        isRunningAgent: true,
        status: 'idle'
      }),
      getTerminalProcessIncarnation: () => 'pty:term-codex:1',
      closeTerminal: unused,
      waitForTerminal: async (handle) => ({
        handle,
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      }),
      listRoomRunningAgents: async () => [],
      listRoomExistingAgents: async () => [],
      resolveRoomHistoricalSession: unused,
      stageRoomAttachment: unused
    }
    const service = new RoomService(':memory:', runtime)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    service.db.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:codex',
      terminalHandle: 'term-codex',
      providerSession: { key: 'session_id', id: 'session-codex' }
    })
    try {
      await service.sendMessage({
        roomId: snapshot.room.id,
        senderIdentity: snapshot.participants[0].identity,
        body: 'Review this'
      })
      await vi.waitFor(() => expect(order).toEqual(['send']))

      const stopping = service.stopRoom(snapshot.room.id)
      release()
      await stopping

      expect(order).toEqual(['send', 'esc', 'cleanup'])
      expect(service.snapshot(snapshot.room.id).workState).toBe('stopped')
    } finally {
      service.close()
    }
  })

  it('seals every unresolved delivery and interrupts only attempts that may have submitted', async () => {
    const unused = async (): Promise<never> => {
      throw new Error('unused')
    }
    const sendTerminal = vi.fn(async (handle: string, action: { text?: string }) => ({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(action.text ?? '')
    }))
    const runtime: RoomHarnessRuntime = {
      createAgentSession: unused,
      ensureAgentSession: unused,
      sendTerminalAgentPrompt: unused,
      sendTerminal,
      waitForTerminalAgentInputReady: async () => true,
      compactTerminalAgentSession: unused,
      getTerminalAgentStatus: unused,
      getTerminalProcessIncarnation: () => null,
      closeTerminal: unused,
      waitForTerminal: async (handle) => ({
        handle,
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      }),
      listRoomRunningAgents: async () => [],
      listRoomExistingAgents: async () => [],
      resolveRoomHistoricalSession: unused,
      stageRoomAttachment: unused
    }
    const service = new RoomService(':memory:', runtime)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const participants = ['alpha', 'beta', 'gamma'].map((identity) =>
      service.db.participants.add({
        roomId: snapshot.room.id,
        identity,
        displayName: identity,
        agent: 'codex',
        worktreeId: 'worktree-1',
        paneKey: `tab:${identity}`,
        terminalHandle: `term-${identity}`,
        providerSession: { key: 'session_id', id: `session-${identity}` }
      })
    )
    const created = service.db.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'Review this'
    })
    const delivery = (identity: string) =>
      created.deliveries.find(
        (candidate) =>
          candidate.participantId ===
          participants.find((participant) => participant.identity === identity)!.id
      )!
    const submitted = delivery('alpha')
    claimRoomBroadcastForTest(service.db, created.message.id)
    service.db.messages.deliveries.setPhase(submitted.id, 'awaiting-turn')
    service.db.activities.upsert({
      participantId: participants[0]!.id,
      identity: 'alpha',
      state: 'working',
      kind: 'command',
      messages: [],
      startedAt: 100,
      updatedAt: 110,
      anchorSequence: created.message.sequence
    })
    service.db.messages.deliveries.complete(delivery('beta').id, 'pending', 'retry')
    const uncertain = delivery('gamma')
    service.db.messages.deliveries.setPhase(uncertain.id, 'awaiting-turn')
    service.db.messages.deliveries.complete(
      uncertain.id,
      'failed',
      'room_delivery_uncertain',
      Number.MAX_SAFE_INTEGER
    )

    try {
      await expect(service.stopRoom(snapshot.room.id)).resolves.toBe(3)
      expect(service.db.messages.deliveries.get(submitted.id)).toMatchObject({
        state: 'delivered',
        error: null,
        respondedAt: expect.any(Number)
      })
      expect(service.db.messages.deliveries.get(delivery('beta').id)).toMatchObject({
        state: 'suppressed',
        error: 'room_stopped'
      })
      expect(service.db.messages.deliveries.get(uncertain.id)).toMatchObject({
        state: 'suppressed',
        error: 'room_stopped'
      })
      expect(service.snapshot(snapshot.room.id).workState).toBe('stopped')
      expect(service.snapshot(snapshot.room.id).activities).toEqual([])
      expect(
        service
          .listMessages(snapshot.room.id, null)
          .messages.find((message) => message.senderIdentity === 'alpha')?.metadata.activity
      ).toMatchObject({ state: 'interrupted', startedAt: 100 })
      expect(sendTerminal).toHaveBeenCalledTimes(2)
      expect(sendTerminal).toHaveBeenCalledWith('term-alpha', { text: '\x1b' })
      expect(sendTerminal).toHaveBeenCalledWith('term-gamma', { text: '\x1b' })
    } finally {
      service.close()
    }
  })

  it('finalizes successful participants and lets Stop retry the one that failed', async () => {
    let betaReady = false
    const unused = async (): Promise<never> => {
      throw new Error('unused')
    }
    const runtime: RoomHarnessRuntime = {
      createAgentSession: unused,
      ensureAgentSession: unused,
      sendTerminalAgentPrompt: unused,
      sendTerminal: async (handle, action) => ({
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(action.text ?? '')
      }),
      waitForTerminalAgentInputReady: unused,
      compactTerminalAgentSession: unused,
      getTerminalAgentStatus: unused,
      getTerminalProcessIncarnation: () => null,
      closeTerminal: unused,
      waitForTerminal: async (handle) => {
        if (handle === 'term-beta' && !betaReady) {
          throw new Error('timeout')
        }
        return {
          handle,
          condition: 'tui-idle',
          satisfied: true,
          status: 'running',
          exitCode: null
        }
      },
      listRoomRunningAgents: async () => [],
      listRoomExistingAgents: async () => [],
      resolveRoomHistoricalSession: unused,
      stageRoomAttachment: unused
    }
    const service = new RoomService(':memory:', runtime)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const participants = ['alpha', 'beta'].map((identity) =>
      service.db.participants.add({
        roomId: snapshot.room.id,
        identity,
        displayName: identity,
        agent: 'codex',
        worktreeId: 'worktree-1',
        paneKey: `tab:${identity}`,
        terminalHandle: `term-${identity}`,
        providerSession: { key: 'session_id', id: `session-${identity}` }
      })
    )
    const created = service.db.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: snapshot.participants[0].identity,
      actorKind: 'user',
      body: 'Review this'
    })
    claimRoomBroadcastForTest(service.db, created.message.id)
    for (const delivery of created.deliveries) {
      service.db.messages.deliveries.setPhase(delivery.id, 'awaiting-turn')
    }
    const deliveryFor = (identity: string) =>
      created.deliveries.find(
        (delivery) =>
          delivery.participantId ===
          participants.find((participant) => participant.identity === identity)!.id
      )!

    try {
      await expect(service.stopRoom(snapshot.room.id)).rejects.toThrow('room_agent_not_ready')
      expect(service.db.messages.deliveries.get(deliveryFor('alpha').id).error).toBe('room_stopped')
      expect(service.db.messages.deliveries.get(deliveryFor('beta').id).error).toBe('room_stopping')
      expect(service.snapshot(snapshot.room.id).workState).toBe('active')
      await expect(service.resumeRoom(snapshot.room.id)).rejects.toThrow('room_stop_in_progress')

      betaReady = true
      await expect(service.stopRoom(snapshot.room.id)).resolves.toBe(1)
      expect(service.db.messages.deliveries.get(deliveryFor('beta').id).error).toBe('room_stopped')
      expect(service.snapshot(snapshot.room.id).workState).toBe('stopped')
    } finally {
      service.close()
    }
  })
})
