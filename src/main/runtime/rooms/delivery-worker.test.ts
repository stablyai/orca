import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalAgentStatus } from '../../../shared/runtime-types'
import { RoomDatabase } from './database'
import { createRoomHarnessAdapters, type RoomHarnessRuntime } from './harness-adapter'
import type { RoomAttachmentManager } from './attachments'
import { RoomDeliveryWorker } from './delivery-worker'
import { deliveryFailureState } from './delivery-selection'
import { roomDeliveryAttemptsFromTurn } from './delivery-prompt'

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
    const status = vi.fn(
      async (handle: string): Promise<RuntimeTerminalAgentStatus> => ({
        handle,
        isRunningAgent: true,
        status: 'idle'
      })
    )
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

  it('suppresses a queued delivery when its participant is paused before send', async () => {
    const harness = worker(10_000, true)
    try {
      harness.db.participants.update(harness.participantId, { participation: 'paused' })
      harness.worker.start()
      await vi.waitFor(() => {
        expect(harness.db.messages.deliveries.get(harness.deliveryId).state).toBe('suppressed')
      })
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
      harness.status.mockImplementation(async (handle: string) => ({
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
      harness.status.mockImplementation(async (handle: string) => ({
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
