import { describe, expect, it, vi } from 'vitest'
import { RoomDatabase } from './database'
import type { RoomHarnessRuntime } from './harness-adapter'
import { RoomService } from './service'

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
    database.transaction(() => database.messages.deliveries.stopRoom(snapshot.room.id))
    const second = database.messages.create({
      roomId: snapshot.room.id,
      senderId: snapshot.participants[0].id,
      senderIdentity: 'egor',
      actorKind: 'user',
      body: 'Stopped by the loop limit'
    })
    const loopDelivery = second.deliveries[0]
    database.messages.deliveries.claim(loopDelivery.id)
    database.messages.deliveries.complete(
      loopDelivery.id,
      'suppressed',
      null,
      Number.MAX_SAFE_INTEGER
    )

    expect(database.messages.deliveries.resumeRoom(snapshot.room.id, 100)).toMatchObject([
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
    expect(database.messages.deliveries.resumeRoom(snapshot.room.id, 103)).toMatchObject([
      { id: loopDelivery.id, state: 'pending' }
    ])
    database.close()
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
    service.db.messages.deliveries.claim(delivery.id)
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
    service.db.messages.deliveries.claim(delivery.id)
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

  it('finishes an in-flight prompt cleanup before writing ESC', async () => {
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

      expect(order).toEqual(['send', 'cleanup', 'esc'])
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
    service.db.messages.deliveries.claim(submitted.id)
    service.db.messages.deliveries.setPhase(submitted.id, 'awaiting-turn')
    const uncertain = delivery('gamma')
    service.db.messages.deliveries.claim(uncertain.id)
    service.db.messages.deliveries.setPhase(uncertain.id, 'awaiting-turn')
    service.db.messages.deliveries.complete(
      uncertain.id,
      'failed',
      'room_delivery_uncertain',
      Number.MAX_SAFE_INTEGER
    )

    try {
      await expect(service.stopRoom(snapshot.room.id)).resolves.toBe(3)
      expect(created.deliveries.map((item) => service.db.messages.deliveries.get(item.id))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: 'suppressed', error: 'room_stopped' }),
          expect.objectContaining({ state: 'suppressed', error: 'room_stopped' }),
          expect.objectContaining({ state: 'suppressed', error: 'room_stopped' })
        ])
      )
      expect(service.snapshot(snapshot.room.id).workState).toBe('stopped')
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
    for (const delivery of created.deliveries) {
      service.db.messages.deliveries.claim(delivery.id)
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

      betaReady = true
      await expect(service.stopRoom(snapshot.room.id)).resolves.toBe(1)
      expect(service.db.messages.deliveries.get(deliveryFor('beta').id).error).toBe('room_stopped')
      expect(service.snapshot(snapshot.room.id).workState).toBe('stopped')
    } finally {
      service.close()
    }
  })
})
