import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalAgentStatus } from '../../../shared/runtime-types'
import { RoomDatabase } from './database'
import { createRoomHarnessAdapters, type RoomHarnessRuntime } from './harness-adapter'
import type { RoomAttachmentManager } from './attachments'
import { RoomDeliveryWorker } from './delivery-worker'
import { deliveryFailureState } from './delivery-selection'
import { roomDeliveryAttemptsFromTurn } from './delivery-prompt'
import { roomHarnessAdapterTestRecord } from './room-harness-adapter-test-record'

describe('room delivery retry state', () => {
  it('only exposes a terminal failure after retries are exhausted', () => {
    expect(deliveryFailureState(false)).toBe('pending')
    expect(deliveryFailureState(true)).toBe('failed')
  })
})

describe('room delivery turn correlation', () => {
  it('extracts the stable delivery id through harness framing', () => {
    const prompt = '<orca-room-delivery id="delivery-1">\nmessage\n</orca-room-delivery>'
    expect(roomDeliveryAttemptsFromTurn(prompt)).toEqual([
      { deliveryId: 'delivery-1', attempt: null }
    ])
    expect(roomDeliveryAttemptsFromTurn(`<harness>\n${prompt}\n</harness>`)).toHaveLength(1)
    expect(roomDeliveryAttemptsFromTurn('a simultaneous direct question')).toEqual([])
    expect(
      roomDeliveryAttemptsFromTurn(
        '<orca-room-delivery id="delivery-1" response="required" attempt="2">'
      )
    ).toEqual([{ deliveryId: 'delivery-1', attempt: 2 }])
  })
})

describe('room delivery confirmation deadline', () => {
  function worker(
    deadlineMs: number,
    withAttachments = false,
    directed = true
  ): {
    db: RoomDatabase
    worker: RoomDeliveryWorker
    send: ReturnType<typeof vi.fn>
    status: ReturnType<typeof vi.fn>
    stage: ReturnType<typeof vi.fn>
    deliveryId: string
    participantId: string
    dispose: () => void
  } {
    const send = vi.fn(
      async (
        handle: string,
        prompt: string,
        _options?: { beforeWrite?: (ptyId: string) => void | Promise<void> }
      ) => ({
        handle,
        accepted: true,
        bytesWritten: Buffer.byteLength(prompt)
      })
    )
    const status = vi.fn(async (handle: string): Promise<RuntimeTerminalAgentStatus> => ({
      handle,
      isRunningAgent: true,
      status: 'idle'
    }))
    const stage = vi.fn(
      async (
        _worktreeId: string,
        _handle: string,
        attachment: { id: string; fileName: string; localPath: string }
      ) => `/staged/${attachment.id}-${attachment.fileName}`
    )
    const unused = async (): Promise<never> => {
      throw new Error('unused')
    }
    const runtime: RoomHarnessRuntime = {
      createAgentSession: unused,
      ensureAgentSession: unused,
      sendTerminalAgentPrompt: send,
      waitForTerminalAgentInputReady: unused,
      compactTerminalAgentSession: unused,
      getTerminalAgentStatus: status,
      getTerminalProcessIncarnation: () => 'pty:term-codex:1',
      closeTerminal: unused,
      waitForTerminal: unused,
      listRoomRunningAgents: async () => [],
      listRoomExistingAgents: async () => [],
      resolveRoomHistoricalSession: unused,
      stageRoomAttachment: stage
    }
    const db = new RoomDatabase(':memory:')
    const snapshot = db.createRoom({ projectId: 'project-1', name: 'Research' })
    const user = snapshot.participants[0]
    const codex = db.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:codex',
      terminalHandle: 'term-codex',
      providerSession: { key: 'session_id', id: 'session-1' }
    })
    if (withAttachments) {
      db.messages.create({
        roomId: snapshot.room.id,
        senderId: user.id,
        senderIdentity: user.identity,
        actorKind: 'user',
        body: 'Read the older report.',
        attachments: [
          {
            id: 'old-report',
            fileName: 'report.pdf',
            mimeType: 'application/pdf',
            byteSize: 4,
            localPath: '/stored/report.pdf'
          }
        ],
        enqueueDeliveries: false
      })
    }
    const { deliveries } = db.messages.create({
      roomId: snapshot.room.id,
      senderId: user.id,
      senderIdentity: user.identity,
      actorKind: 'user',
      body: '@codex hello',
      mentions: directed ? ['codex'] : [],
      attachments: withAttachments
        ? [
            {
              id: 'current-image',
              fileName: 'current.png',
              mimeType: 'image/png',
              byteSize: 4,
              localPath: '/stored/current.png'
            }
          ]
        : []
    })
    const deliveryWorker = new RoomDeliveryWorker(
      db,
      createRoomHarnessAdapters(runtime),
      { size: async () => 4 } as unknown as RoomAttachmentManager,
      () => {},
      async (participantId) => db.participants.get(participantId),
      deadlineMs
    )
    return {
      db,
      worker: deliveryWorker,
      send,
      status,
      stage,
      deliveryId: deliveries[0].id,
      participantId: codex.id,
      dispose: () => {
        deliveryWorker.dispose()
        db.close()
      }
    }
  }

  it('stages only current attachments and never catches up prior messages', async () => {
    const harness = worker(10_000, true)
    try {
      harness.worker.start()
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1))

      const prompt = harness.send.mock.calls[0][1] as string
      expect(prompt).not.toContain('Read the older report.')
      expect(prompt).not.toContain('room-context-ref')
      expect(prompt).toContain('/staged/current-image-current.png')
      expect(harness.stage).toHaveBeenCalledOnce()
      expect(harness.stage).toHaveBeenCalledWith('worktree-1', 'term-codex', {
        id: 'current-image',
        fileName: 'current.png',
        localPath: '/stored/current.png'
      })
      expect(harness.send).toHaveBeenCalledWith('term-codex', prompt, {
        beforeWrite: expect.any(Function),
        clearInput: false,
        imagePaths: ['/staged/current-image-current.png']
      })
    } finally {
      harness.dispose()
    }
  })

  it('marks an unaddressed active-agent delivery as optional', async () => {
    const harness = worker(10_000, false, false)
    try {
      harness.worker.start()
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledOnce())
      const prompt = harness.send.mock.calls[0][1] as string
      expect(prompt).toContain('response="optional"')
      expect(prompt).toContain('otherwise return exactly <orca-room-silent />')
    } finally {
      harness.dispose()
    }
  })

  it('leaves a queued delivery fenced while its participant is paused', () => {
    const harness = worker(10_000, true)
    try {
      const deliveries = harness.db.messages.deliveries
      const roomId = harness.db.messages.get(deliveries.get(harness.deliveryId).messageId).roomId
      harness.db.participants.update(harness.participantId, { participation: 'paused' })
      harness.worker.start()
      expect(deliveries.listDue()).toEqual([])
      expect(deliveries.nextDueAt()).toBeNull()
      expect(deliveries.workState(roomId)).toBe('idle')
      expect(deliveries.get(harness.deliveryId).state).toBe('pending')
      expect(harness.send).not.toHaveBeenCalled()
    } finally {
      harness.dispose()
    }
  })

  it('fences every remaining PTY write after the room is stopped', async () => {
    const harness = worker(10_000)
    try {
      harness.worker.start()
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledOnce())
      harness.db.transaction(() =>
        harness.db.messages.deliveries.stopRoom(
          harness.db.messages.get(harness.db.messages.deliveries.get(harness.deliveryId).messageId)
            .roomId
        )
      )
      const beforeWrite = harness.send.mock.calls[0][2]?.beforeWrite
      expect(beforeWrite).toBeTypeOf('function')
      expect(() => beforeWrite?.('pty-1')).toThrow('room_delivery_stopped')
    } finally {
      harness.dispose()
    }
  })

  it('requires an explicit retry after Enter and correlates a glued retry marker', async () => {
    const harness = worker(150, true)
    try {
      harness.worker.start()
      await vi.waitFor(() => {
        expect(harness.send).toHaveBeenCalledTimes(1)
        expect(harness.db.messages.deliveries.get(harness.deliveryId).state).toBe('delivering')
      })
      const firstPrompt = harness.send.mock.calls[0][1] as string
      const firstStage = harness.stage.mock.calls.map(([, , attachment]) => ({
        id: attachment.id,
        fileName: attachment.fileName
      }))

      await vi.waitFor(() => {
        expect(harness.db.messages.deliveries.get(harness.deliveryId)).toMatchObject({
          state: 'failed',
          error: 'room_delivery_uncertain'
        })
      })
      expect(harness.send).toHaveBeenCalledTimes(1)
      harness.db.messages.deliveries.retry(harness.deliveryId)
      harness.worker.wake()
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(2))
      const secondStage = harness.stage.mock.calls
        .slice(firstStage.length)
        .map(([, , attachment]) => ({
          id: attachment.id,
          fileName: attachment.fileName
        }))
      expect(secondStage).toEqual(firstStage)
      const secondPrompt = harness.send.mock.calls[1][1] as string
      const confirmed = harness.worker.confirmTurn(harness.participantId, {
        id: 'turn-1',
        text: `${firstPrompt}\n${secondPrompt}`
      })
      expect(confirmed?.state).toBe('delivered')
      expect(confirmed?.providerTurnId).toBe('turn-1')
      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(harness.db.messages.deliveries.get(harness.deliveryId).state).toBe('delivered')
      expect(harness.send).toHaveBeenCalledTimes(2)
    } finally {
      harness.dispose()
    }
  })

  it('keeps waiting while the agent is working instead of resending into its turn', async () => {
    const harness = worker(30)
    try {
      harness.status
        .mockResolvedValueOnce({
          handle: 'term-codex',
          isRunningAgent: true,
          status: 'idle' as const
        })
        .mockImplementation(async (handle: string) => ({
          handle,
          isRunningAgent: true,
          status: 'working' as const
        }))
      harness.worker.start()
      await vi.waitFor(() => {
        expect(harness.send).toHaveBeenCalledTimes(1)
      })

      // Facts say a turn is running (ours, with the watcher lagging): re-arm, never resend.
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(harness.db.messages.deliveries.get(harness.deliveryId).state).toBe('delivering')
      expect(harness.send).toHaveBeenCalledTimes(1)

      harness.status.mockImplementation(async (handle: string) => ({
        handle,
        isRunningAgent: true,
        status: 'idle' as const
      }))
      await vi.waitFor(() => {
        expect(harness.db.messages.deliveries.get(harness.deliveryId)).toMatchObject({
          state: 'failed',
          error: 'room_delivery_uncertain'
        })
      })
      expect(harness.send).toHaveBeenCalledTimes(1)
    } finally {
      harness.dispose()
    }
  })

  it('never blindly resends when the accepted turn state is unknown', async () => {
    const harness = worker(30)
    try {
      harness.status
        .mockResolvedValueOnce({
          handle: 'term-codex',
          isRunningAgent: true,
          status: 'idle' as const
        })
        .mockImplementation(async (handle: string) => ({
          handle,
          isRunningAgent: true,
          status: null
        }))
      harness.worker.start()
      await vi.waitFor(() => {
        expect(harness.db.messages.deliveries.get(harness.deliveryId)).toMatchObject({
          state: 'failed',
          error: 'room_delivery_uncertain'
        })
      })
      expect(harness.send).toHaveBeenCalledTimes(1)

      const prompt = harness.send.mock.calls[0][1] as string
      const confirmed = harness.worker.confirmTurn(harness.participantId, {
        id: 'late-turn',
        text: prompt
      })
      expect(confirmed).toMatchObject({ state: 'delivered', providerTurnId: 'late-turn' })
    } finally {
      harness.dispose()
    }
  })
})

describe('room machine steer', () => {
  it('leaves a next delivery pending without attempts while the machine turn is busy', async () => {
    const snapshot = {
      id: 'conversation-1',
      agent: 'codex' as const,
      cwd: '/repo',
      providerSessionId: 'session-1',
      messages: [],
      queuedMessages: [],
      queueRevision: 0,
      status: 'working' as const,
      updatedAt: 1
    }
    const status = vi.fn(async () => ({
      handle: snapshot.id,
      isRunningAgent: true,
      status: 'working' as const
    }))
    const send = vi.fn()
    const adapters = roomHarnessAdapterTestRecord({ status, send })
    const db = new RoomDatabase(':memory:')
    const room = db.createRoom({ projectId: 'project-1', name: 'Research' })
    const participant = db.participants.add({
      roomId: room.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      providerSession: { key: 'session_id', id: snapshot.id, transport: 'machine' }
    })
    const delivery = db.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: room.participants[0].identity,
      actorKind: 'user',
      body: 'next',
      targetParticipantIds: [participant.id]
    }).deliveries[0]
    const worker = new RoomDeliveryWorker(
      db,
      adapters,
      { size: async () => 0 } as unknown as RoomAttachmentManager,
      () => {},
      async (id) => db.participants.get(id)
    )
    try {
      worker.start()
      await vi.waitFor(() => expect(status).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(db.messages.deliveries.get(delivery.id)).toMatchObject({
        state: 'pending',
        intent: 'next',
        attempts: 0
      })
      expect(send).not.toHaveBeenCalled()
    } finally {
      worker.dispose()
      db.close()
    }
  })

  it('steers busy machines and sends to idle machines in one shared operation', async () => {
    const snapshots = new Map([
      ['conversation-busy', { status: 'working' as const }],
      ['conversation-idle', { status: 'idle' as const }]
    ])
    const send = vi.fn(async (binding) => ({
      handle: binding.conversationId,
      accepted: true,
      bytesWritten: 1
    }))
    const steer = vi.fn(async (binding) => ({
      handle: binding.conversationId,
      accepted: true,
      bytesWritten: 1
    }))
    const adapters = roomHarnessAdapterTestRecord({
      status: async (binding) => ({
        handle: binding.transport === 'machine' ? binding.conversationId : binding.terminalHandle,
        isRunningAgent: true,
        status:
          binding.transport === 'machine' &&
          snapshots.get(binding.conversationId)?.status === 'working'
            ? 'working'
            : 'idle'
      }),
      send,
      steer
    })
    const db = new RoomDatabase(':memory:')
    const room = db.createRoom({ projectId: 'project-1', name: 'Research' })
    const busy = db.participants.add({
      roomId: room.room.id,
      identity: 'busy',
      displayName: 'Busy',
      agent: 'codex',
      worktreeId: 'worktree-busy',
      providerSession: { key: 'session_id', id: 'conversation-busy', transport: 'machine' }
    })
    const idle = db.participants.add({
      roomId: room.room.id,
      identity: 'idle',
      displayName: 'Idle',
      agent: 'codex',
      worktreeId: 'worktree-idle',
      providerSession: { key: 'session_id', id: 'conversation-idle', transport: 'machine' }
    })
    const created = db.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: room.participants[0].identity,
      actorKind: 'user',
      body: 'shared steer'
    })
    const worker = new RoomDeliveryWorker(
      db,
      adapters,
      { size: async () => 0 } as unknown as RoomAttachmentManager,
      () => {},
      async (id) => db.participants.get(id)
    )
    try {
      await worker.steer(created.deliveries[0].id, true)
      expect(
        db.messages.deliveries.get(
          created.deliveries.find((item) => item.participantId === busy.id)!.id
        )
      ).toMatchObject({
        state: 'delivering',
        intent: 'steer',
        attempts: 1
      })
      expect(
        db.messages.deliveries.get(
          created.deliveries.find((item) => item.participantId === idle.id)!.id
        )
      ).toMatchObject({
        state: 'delivering',
        intent: 'next',
        attempts: 1
      })
      expect(steer).toHaveBeenCalledOnce()
      expect(send).toHaveBeenCalledOnce()
    } finally {
      worker.dispose()
      db.close()
    }
  })

  it('uses the machine queue and remains fenced by room deletion', async () => {
    let release = (): void => undefined
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const steer = vi.fn(async () => {
      await blocked
      return { handle: snapshot.id, accepted: true, bytesWritten: 1 }
    })
    const snapshot = {
      id: 'conversation-1',
      agent: 'codex' as const,
      cwd: '/repo',
      providerSessionId: 'session-1',
      messages: [],
      queuedMessages: [],
      queueRevision: 0,
      status: 'working' as const,
      updatedAt: 1
    }
    const adapters = roomHarnessAdapterTestRecord({
      status: async () => ({ handle: snapshot.id, isRunningAgent: true, status: 'working' }),
      steer
    })
    const db = new RoomDatabase(':memory:')
    const room = db.createRoom({ projectId: 'project-1', name: 'Research' })
    const participant = db.participants.add({
      roomId: room.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      providerSession: { key: 'session_id', id: snapshot.id, transport: 'machine' }
    })
    const delivery = db.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: room.participants[0].identity,
      actorKind: 'user',
      body: 'change course',
      targetParticipantIds: [participant.id]
    }).deliveries[0]
    const deliveryWorker = new RoomDeliveryWorker(
      db,
      adapters,
      { size: async () => 0 } as unknown as RoomAttachmentManager,
      () => {},
      async () => {
        throw new Error('room_agent_not_ready')
      }
    )
    try {
      const steering = deliveryWorker.steer(delivery.id, true)
      await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce())
      let roomBlocked = false
      const fence = deliveryWorker.requestRoomFence(room.room.id, {
        discardConfirmations: false
      })
      void fence.ready.then(() => (roomBlocked = true))
      await Promise.resolve()
      expect(roomBlocked).toBe(false)

      release()
      await steering
      await fence.ready
      fence.release()

      expect(steer).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: snapshot.id }),
        expect.stringContaining('change course'),
        undefined
      )
    } finally {
      deliveryWorker.dispose()
      db.close()
    }
  })

  it('returns a definitively rejected steer as an immutable next attempt', async () => {
    const snapshot = {
      id: 'conversation-1',
      agent: 'codex' as const,
      cwd: '/repo',
      providerSessionId: 'session-1',
      messages: [],
      queuedMessages: [] as {
        id: string
        text: string
        imagePaths: string[]
        createdAt: number
        state: 'pending'
      }[],
      queueRevision: 0,
      status: 'working' as const,
      updatedAt: 1
    }
    const steer = vi.fn(async () => {
      throw new Error('codex_steer_rejected')
    })
    const adapters = roomHarnessAdapterTestRecord({
      status: async () => ({ handle: snapshot.id, isRunningAgent: true, status: 'working' }),
      steer
    })
    const db = new RoomDatabase(':memory:')
    const room = db.createRoom({ projectId: 'project-1', name: 'Research' })
    const participant = db.participants.add({
      roomId: room.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      providerSession: { key: 'session_id', id: snapshot.id, transport: 'machine' }
    })
    const delivery = db.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: room.participants[0].identity,
      actorKind: 'user',
      body: 'change course',
      targetParticipantIds: [participant.id]
    }).deliveries[0]
    const worker = new RoomDeliveryWorker(
      db,
      adapters,
      { size: async () => 0 } as unknown as RoomAttachmentManager,
      () => {},
      async (id) => db.participants.get(id)
    )
    try {
      await expect(worker.steer(delivery.id, true)).rejects.toThrow('codex_steer_rejected')
      expect(db.messages.deliveries.get(delivery.id)).toMatchObject({
        state: 'pending',
        intent: 'next',
        attempts: 1,
        error: 'codex_steer_rejected'
      })
      expect(() => db.messages.deliveries.assertMessageMutable(delivery.messageId)).toThrow(
        'room_delivery_queue_stale'
      )
      expect(steer).toHaveBeenCalledOnce()
    } finally {
      worker.dispose()
      db.close()
    }
  })
})

describe('room broadcast retries', () => {
  it('retries one failed participant after the initial group reservation', async () => {
    const sendAttempts = new Map<string, number>()
    const send = vi.fn(async (handle: string, prompt: string) => {
      const attempt = (sendAttempts.get(handle) ?? 0) + 1
      sendAttempts.set(handle, attempt)
      if (handle === 'term-claude' && attempt === 1) {
        throw new Error('temporary_write_failure')
      }
      return { handle, accepted: true, bytesWritten: Buffer.byteLength(prompt) }
    })
    const runtime = {
      ...workerRuntimeStub(),
      sendTerminalAgentPrompt: send,
      getTerminalAgentStatus: vi.fn(async (handle: string) => ({
        handle,
        isRunningAgent: true,
        status: 'idle' as const
      }))
    }
    const db = new RoomDatabase(':memory:')
    const room = db.createRoom({ projectId: 'project-1', name: 'Research' })
    const participants = (['codex', 'claude'] as const).map((identity) =>
      db.participants.add({
        roomId: room.room.id,
        identity,
        displayName: identity,
        agent: identity,
        worktreeId: `worktree-${identity}`,
        paneKey: `tab:${identity}`,
        terminalHandle: `term-${identity}`,
        providerSession: { key: 'session_id', id: `session-${identity}` }
      })
    )
    const created = db.messages.create({
      roomId: room.room.id,
      senderId: room.participants[0].id,
      senderIdentity: room.participants[0].identity,
      actorKind: 'user',
      body: 'broadcast'
    })
    const worker = new RoomDeliveryWorker(
      db,
      createRoomHarnessAdapters(runtime),
      { size: async () => 0 } as unknown as RoomAttachmentManager,
      () => {},
      async (id) => db.participants.get(id)
    )
    try {
      worker.start()
      await vi.waitFor(
        () => {
          expect(sendAttempts.get('term-codex')).toBe(1)
          expect(sendAttempts.get('term-claude')).toBe(2)
        },
        { timeout: 3_000 }
      )
      expect(
        db.messages.deliveries
          .listForMessage(created.message.id)
          .find((delivery) => delivery.participantId === participants[1]!.id)?.attempts
      ).toBe(2)
    } finally {
      worker.dispose()
      db.close()
    }
  })

  it('does not let unknown terminal readiness block another room', async () => {
    const ready = new Set<string>()
    const send = vi.fn(async (handle: string, prompt: string) => ({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(prompt)
    }))
    const waitForInput = vi.fn(() => new Promise<boolean>(() => undefined))
    const runtime = {
      ...workerRuntimeStub(),
      sendTerminalAgentPrompt: send,
      waitForTerminalAgentInputReady: waitForInput,
      getTerminalAgentStatus: vi.fn(async (handle: string) => ({
        handle,
        isRunningAgent: true,
        status: handle === 'term-ready' || ready.has(handle) ? ('idle' as const) : null
      }))
    }
    const db = new RoomDatabase(':memory:')
    const createQueuedRoom = (suffix: string): void => {
      const room = db.createRoom({ projectId: `project-${suffix}`, name: suffix })
      db.participants.add({
        roomId: room.room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex',
        worktreeId: `worktree-${suffix}`,
        paneKey: `tab:${suffix}`,
        terminalHandle: `term-${suffix}`,
        providerSession: { key: 'session_id', id: `session-${suffix}` }
      })
      db.messages.create({
        roomId: room.room.id,
        senderId: room.participants[0].id,
        senderIdentity: room.participants[0].identity,
        actorKind: 'user',
        body: suffix
      })
    }
    createQueuedRoom('blocked')
    createQueuedRoom('ready')
    const worker = new RoomDeliveryWorker(
      db,
      createRoomHarnessAdapters(runtime),
      { size: async () => 0 } as unknown as RoomAttachmentManager,
      () => {},
      async (id) => db.participants.get(id)
    )
    try {
      worker.start()
      await vi.waitFor(() =>
        expect(send.mock.calls.some(([handle]) => handle === 'term-ready')).toBe(true)
      )
      expect(send.mock.calls.some(([handle]) => handle === 'term-blocked')).toBe(false)
      expect(waitForInput).not.toHaveBeenCalled()

      ready.add('term-blocked')
      worker.wake()
      await vi.waitFor(() =>
        expect(send.mock.calls.some(([handle]) => handle === 'term-blocked')).toBe(true)
      )
    } finally {
      worker.dispose()
      db.close()
    }
  })
})

function workerRuntimeStub(): RoomHarnessRuntime {
  const unused = async (): Promise<never> => {
    throw new Error('unused')
  }
  return {
    createAgentSession: unused,
    ensureAgentSession: unused,
    sendTerminalAgentPrompt: unused,
    waitForTerminalAgentInputReady: unused,
    compactTerminalAgentSession: unused,
    getTerminalAgentStatus: unused,
    getTerminalProcessIncarnation: () => null,
    closeTerminal: unused,
    waitForTerminal: unused,
    listRoomRunningAgents: async () => [],
    listRoomExistingAgents: async () => [],
    resolveRoomHistoricalSession: unused,
    stageRoomAttachment: async (_worktreeId, _handle, attachment) => attachment.localPath
  }
}
