import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RoomEvent } from '../../../shared/rooms'
import type { RoomHarnessRuntime } from './harness-adapter'
import { RoomService } from './service'

function line(type: string, payload: Record<string, unknown>, timestamp: number): string {
  return `${JSON.stringify({ type, timestamp: new Date(timestamp).toISOString(), payload })}\n`
}

function runtimeStub(
  events: RoomEvent[],
  sendTerminalAgentPrompt: RoomHarnessRuntime['sendTerminalAgentPrompt'] = async () => {
    throw new Error('unused')
  }
): RoomHarnessRuntime {
  const unused = async (): Promise<never> => {
    throw new Error('unused')
  }
  return {
    createAgentSession: unused,
    ensureAgentSession: unused,
    sendTerminalAgentPrompt,
    sendTerminal: async (handle, action) => ({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(action.text ?? '')
    }),
    waitForTerminalAgentInputReady: async () => true,
    compactTerminalAgentSession: unused,
    getTerminalAgentStatus: async (handle) => ({ handle, isRunningAgent: true, status: 'idle' }),
    getTerminalProcessIncarnation: (handle) => `pty:${handle}:1`,
    closeTerminal: unused,
    waitForTerminal: async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }),
    emitRoomEvent: (_roomId, event) => events.push(event),
    listRoomRunningAgents: async () => [],
    listRoomExistingAgents: async () => [],
    resolveRoomHistoricalSession: unused,
    stageRoomAttachment: unused
  }
}

describe('room transcript bridge lifecycle', () => {
  it.each([
    ['task_complete', 'room_empty_response'],
    ['turn_aborted', 'room_turn_interrupted']
  ])(
    'settles a transcript %s without leaving the participant queue blocked',
    async (type, error) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-room-terminal-'))
      const transcriptPath = join(root, 'rollout.jsonl')
      await writeFile(
        transcriptPath,
        line('event_msg', { type: 'user_message', id: 'prompt-1', message: 'room event' }, 100) +
          line('event_msg', { type: 'task_started', turn_id: 'turn-1' }, 110)
      )
      const service = new RoomService(':memory:', runtimeStub([]))
      try {
        const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
        const agent = service.db.participants.add({
          roomId: room.id,
          identity: 'codex',
          displayName: 'Codex',
          agent: 'codex',
          worktreeId: 'worktree-1',
          paneKey: 'tab:codex',
          terminalHandle: 'term-codex',
          providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
        })
        const user = service.getUserParticipant(room.id)
        const delivery = service.db.messages.create({
          roomId: room.id,
          senderId: user.id,
          senderIdentity: user.identity,
          actorKind: 'user',
          body: 'room event'
        }).deliveries[0]!
        service.db.messages.deliveries.claim(delivery.id)
        service.db.messages.deliveries.confirmTurn(delivery.id, 'prompt-1')
        await service.activateRoom(room.id)

        await appendFile(transcriptPath, line('event_msg', { type, turn_id: 'turn-1' }, 120))

        await vi.waitFor(() =>
          expect(service.db.messages.deliveries.get(delivery.id)).toMatchObject({
            state: 'failed',
            error
          })
        )
        expect(service.db.participants.get(agent.id).state).not.toBe('busy')
      } finally {
        service.close()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('drops a final that arrives after the room was stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-stopped-final-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeFile(
      transcriptPath,
      line('event_msg', { type: 'user_message', id: 'prompt-1', message: 'room event' }, 100) +
        line('event_msg', { type: 'task_started', turn_id: 'turn-1' }, 110)
    )
    const events: RoomEvent[] = []
    const service = new RoomService(':memory:', runtimeStub(events))
    try {
      const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
      const agent = service.db.participants.add({
        roomId: room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex',
        worktreeId: 'worktree-1',
        paneKey: 'tab:codex',
        terminalHandle: 'term-codex',
        providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
      })
      const user = service.getUserParticipant(room.id)
      const delivery = service.db.messages.create({
        roomId: room.id,
        senderId: user.id,
        senderIdentity: user.identity,
        actorKind: 'user',
        body: 'room event'
      }).deliveries[0]!
      service.db.messages.deliveries.claim(delivery.id)
      service.db.messages.deliveries.confirmTurn(delivery.id, 'prompt-1')
      await service.activateRoom(room.id)
      await vi.waitFor(() => expect(service.db.participants.get(agent.id).state).toBe('busy'))

      await service.stopRoom(room.id)
      await appendFile(
        transcriptPath,
        line('event_msg', { type: 'agent_message', id: 'final', message: 'Too late.' }, 120) +
          line('event_msg', { type: 'task_complete', turn_id: 'turn-1' }, 130)
      )
      await vi.waitFor(() => expect(service.db.participants.get(agent.id).lastSeenAt).toBe(130))

      expect(service.db.messages.deliveries.get(delivery.id)).toMatchObject({
        state: 'suppressed',
        error: 'room_stopped',
        responseMessageId: null
      })
      expect(
        service
          .listMessages(room.id, null)
          .messages.filter((message) => message.actorKind === 'agent')
      ).toEqual([])
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('publishes only the confirmed final answer of the delivery turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-lifecycle-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeFile(
      transcriptPath,
      line(
        'event_msg',
        { type: 'user_message', id: 'prompt-1', message: '@codex inspect the repository' },
        1_799_999_999_990
      ) + line('event_msg', { type: 'task_started', turn_id: 'turn-1' }, 1_800_000_000_000)
    )
    const events: RoomEvent[] = []
    const service = new RoomService(':memory:', runtimeStub(events))
    try {
      const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
      const agent = service.db.participants.add({
        roomId: room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex',
        worktreeId: 'worktree-1',
        paneKey: 'tab:codex',
        terminalHandle: 'term-codex',
        providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
      })
      const user = service.getUserParticipant(room.id)
      const trigger = service.db.messages.create({
        roomId: room.id,
        senderId: user.id,
        senderIdentity: user.identity,
        actorKind: 'user',
        body: '@codex inspect the repository',
        mentions: [agent.identity]
      })
      const delivery = trigger.deliveries[0]!
      service.db.messages.deliveries.claim(delivery.id)
      // The delivery was bound to the transcript's 'prompt-1' user turn.
      service.db.messages.deliveries.confirmTurn(delivery.id, 'prompt-1', 1_799_999_999_995)

      await service.activateRoom(room.id)
      await vi.waitFor(() => {
        expect(service.db.participants.get(agent.id).state).toBe('busy')
      })
      await appendFile(
        transcriptPath,
        line(
          'event_msg',
          { type: 'agent_message', id: 'commentary', message: 'I am checking that.' },
          1_800_000_000_010
        ) +
          line(
            'response_item',
            { type: 'local_shell_call', id: 'command', action: { command: 'git status' } },
            1_800_000_000_020
          )
      )
      await vi.waitFor(() => {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'activity.updated',
            activity: expect.objectContaining({
              participantId: agent.id,
              state: 'working',
              kind: 'command',
              startedAt: 1_799_999_999_995,
              anchorSequence: trigger.message.sequence
            })
          })
        )
      })
      await appendFile(
        transcriptPath,
        line(
          'event_msg',
          { type: 'agent_message', id: 'final', message: 'Confirmed final answer.' },
          1_800_000_000_030
        ) + line('event_msg', { type: 'task_complete', turn_id: 'turn-1' }, 1_800_000_000_040)
      )
      await vi.waitFor(
        () => {
          const replies = service
            .listMessages(room.id, null)
            .messages.filter((message) => message.actorKind === 'agent')
          expect(replies.map((message) => message.body)).toEqual(['Confirmed final answer.'])
          expect(replies[0]?.replyToId).toBe(trigger.message.id)
          expect(replies[0]?.metadata.activity).toMatchObject({
            state: 'completed',
            completedAt: 1_800_000_000_040,
            messages: [
              expect.objectContaining({ id: 'commentary' }),
              expect.objectContaining({ id: 'command' })
            ]
          })
        },
        { timeout: 5_000 }
      )
      expect(events).toContainEqual({ type: 'activity.cleared', participantId: agent.id })
      expect(service.db.participants.get(agent.id).state).toBe('online')
      expect(service.db.messages.deliveries.get(delivery.id).responseMessageId).not.toBeNull()
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'delivery.updated',
          delivery: expect.objectContaining({
            id: delivery.id,
            state: 'delivered',
            responseMessageId: expect.any(String)
          })
        })
      )
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('completes an optional delivery without publishing a silent acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-silent-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeFile(
      transcriptPath,
      line('event_msg', { type: 'user_message', id: 'prompt-1', message: 'room event' }, 100) +
        line('event_msg', { type: 'task_started', turn_id: 'turn-1' }, 110)
    )
    const events: RoomEvent[] = []
    const send = vi.fn(async (handle: string) => ({ handle, accepted: true, bytesWritten: 1 }))
    const service = new RoomService(':memory:', runtimeStub(events, send))
    try {
      const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
      const agent = service.db.participants.add({
        roomId: room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex',
        worktreeId: 'worktree-1',
        paneKey: 'tab:codex',
        terminalHandle: 'term-codex',
        providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
      })
      const user = service.getUserParticipant(room.id)
      const trigger = service.db.messages.create({
        roomId: room.id,
        senderId: user.id,
        senderIdentity: user.identity,
        actorKind: 'user',
        body: 'room event'
      })
      const delivery = trigger.deliveries[0]!
      service.db.messages.deliveries.claim(delivery.id)
      service.db.messages.deliveries.confirmTurn(delivery.id, 'prompt-1')
      const queued = service.db.messages.create({
        roomId: room.id,
        senderId: user.id,
        senderIdentity: user.identity,
        actorKind: 'user',
        body: 'next room event'
      }).deliveries[0]!

      await service.activateRoom(room.id)
      await appendFile(
        transcriptPath,
        line(
          'event_msg',
          { type: 'agent_message', id: 'silent', message: '<orca-room-silent />' },
          120
        ) + line('event_msg', { type: 'task_complete', turn_id: 'turn-1' }, 130)
      )

      await vi.waitFor(() => {
        expect(service.db.messages.deliveries.get(delivery.id)).toMatchObject({
          respondedAt: 130,
          responseMessageId: null
        })
      })
      expect(
        service
          .listMessages(room.id, null)
          .messages.filter((message) => message.actorKind === 'agent')
      ).toEqual([])
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'delivery.updated',
          delivery: expect.objectContaining({ id: delivery.id, respondedAt: 130 })
        })
      )
      expect(service.currentTurnDeliveryIdForPane(agent.paneKey!)).toBe(delivery.id)
      expect(service.transcriptBridge.currentTurnDeliveryIdForConversation('session-1')).toBe(
        delivery.id
      )
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      expect(service.db.messages.deliveries.get(queued.id).state).toBe('delivering')
      expect(service.db.participants.get(agent.id).state).toBe('online')
      await appendFile(
        transcriptPath,
        line(
          'event_msg',
          {
            type: 'user_message',
            id: 'direct-literal',
            message: 'Explain <orca-room-delivery id="example"> as XML.'
          },
          140
        )
      )
      await vi.waitFor(() =>
        expect(
          service.transcriptBridge.currentTurnDeliveryIdForConversation('session-1')
        ).toBeNull()
      )
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails a Claude provider error without publishing or fanning it out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-provider-error-'))
    const transcriptPath = join(root, 'claude.jsonl')
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'prompt-1',
        timestamp: '2026-08-10T00:32:40.000Z',
        message: { role: 'user', content: 'room event' }
      })}\n`
    )
    const events: RoomEvent[] = []
    const service = new RoomService(':memory:', runtimeStub(events))
    try {
      const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
      const agent = service.db.participants.add({
        roomId: room.id,
        identity: 'claude',
        displayName: 'Claude',
        agent: 'claude',
        worktreeId: 'worktree-1',
        paneKey: 'tab:claude',
        terminalHandle: 'term-claude',
        providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
      })
      const user = service.getUserParticipant(room.id)
      const trigger = service.db.messages.create({
        roomId: room.id,
        senderId: user.id,
        senderIdentity: user.identity,
        actorKind: 'user',
        body: 'room event'
      })
      const delivery = trigger.deliveries[0]!
      service.db.messages.deliveries.claim(delivery.id)
      service.db.messages.deliveries.confirmTurn(delivery.id, 'prompt-1')

      await service.activateRoom(room.id)
      await appendFile(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant',
          uuid: 'api-error',
          isApiErrorMessage: true,
          timestamp: '2026-08-10T00:32:45.261Z',
          message: {
            role: 'assistant',
            model: '<synthetic>',
            stop_reason: 'stop_sequence',
            content: [
              { type: 'text', text: 'API Error: 400 speed: Extra inputs are not permitted' }
            ]
          }
        })}\n`
      )

      await vi.waitFor(() => {
        expect(service.db.messages.deliveries.get(delivery.id)).toMatchObject({
          state: 'failed',
          error: 'room_provider_error'
        })
      })
      expect(
        service
          .listMessages(room.id, null)
          .messages.filter((message) => message.actorKind === 'agent')
      ).toEqual([])
      expect(service.db.messages.deliveries.listForMessage(trigger.message.id)).toHaveLength(1)
      expect(service.db.participants.get(agent.id).state).toBe('online')
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps direct CLI turns in the transcript without publishing them to the room', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-direct-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeFile(
      transcriptPath,
      line('event_msg', { type: 'task_started', turn_id: 'boot' }, 1000)
    )
    const events: RoomEvent[] = []
    const service = new RoomService(':memory:', runtimeStub(events))
    try {
      const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
      const agent = service.db.participants.add({
        roomId: room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex',
        worktreeId: 'worktree-1',
        paneKey: 'tab:codex',
        terminalHandle: 'term-codex',
        providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
      })
      await service.activateRoom(room.id)
      await appendFile(
        transcriptPath,
        line(
          'event_msg',
          { type: 'user_message', id: 'direct-1', message: 'a private question from the CLI' },
          2000
        ) +
          line(
            'event_msg',
            { type: 'agent_message', id: 'direct-answer', message: 'A private answer.' },
            2100
          ) +
          line('event_msg', { type: 'task_complete', turn_id: 'direct-turn' }, 2200)
      )
      await vi.waitFor(() => {
        expect(service.db.participants.get(agent.id).state).toBe('online')
        expect(service.db.participants.get(agent.id).lastSeenAt).not.toBeNull()
      })
      expect(
        service.listMessages(room.id, null).messages.filter((item) => item.actorKind === 'agent')
      ).toEqual([])
      expect(service.currentTurnDeliveryIdForPane(agent.paneKey!)).toBeNull()
      expect(service.transcriptBridge.currentTurnDeliveryIdForConversation('session-1')).toBeNull()
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps simultaneous agent timelines isolated on their own final messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-concurrent-lifecycle-'))
    const alphaPath = join(root, 'alpha.jsonl')
    const betaPath = join(root, 'beta.jsonl')
    await Promise.all([
      writeFile(
        alphaPath,
        line('event_msg', { type: 'user_message', id: 'alpha-prompt', message: 'go alpha' }, 900) +
          line('event_msg', { type: 'task_started', turn_id: 'a' }, 1000)
      ),
      writeFile(
        betaPath,
        line('event_msg', { type: 'user_message', id: 'beta-prompt', message: 'go beta' }, 1900) +
          line('event_msg', { type: 'task_started', turn_id: 'b' }, 2000)
      )
    ])
    const events: RoomEvent[] = []
    const service = new RoomService(':memory:', runtimeStub(events))
    try {
      const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
      for (const [identity, transcriptPath] of [
        ['alpha', alphaPath],
        ['beta', betaPath]
      ] as const) {
        service.db.participants.add({
          roomId: room.id,
          identity,
          displayName: identity,
          agent: 'codex',
          worktreeId: 'worktree-1',
          paneKey: `tab:${identity}`,
          terminalHandle: `term-${identity}`,
          providerSession: { key: 'session_id', id: identity, transcriptPath }
        })
      }
      const user = service.getUserParticipant(room.id)
      const agents = service.db.participants
        .list(room.id)
        .filter((item) => item.actorKind === 'agent')
      const trigger = service.db.messages.create({
        roomId: room.id,
        senderId: user.id,
        senderIdentity: user.identity,
        actorKind: 'user',
        body: '@alpha @beta go',
        mentions: agents.map((item) => item.identity)
      })
      for (const delivery of trigger.deliveries) {
        const participant = agents.find((item) => item.id === delivery.participantId)!
        service.db.messages.deliveries.claim(delivery.id)
        service.db.messages.deliveries.confirmTurn(delivery.id, `${participant.identity}-prompt`)
      }
      await service.activateRoom(room.id)
      await vi.waitFor(() => {
        expect(
          service.db.participants
            .list(room.id)
            .filter((item) => item.actorKind === 'agent')
            .every((item) => item.state === 'busy')
        ).toBe(true)
      })
      await Promise.all([
        appendFile(
          alphaPath,
          line('event_msg', { type: 'agent_message', id: 'a-note', message: 'Alpha note.' }, 1100) +
            line(
              'event_msg',
              { type: 'agent_message', id: 'a-final', message: 'Alpha final.' },
              1200
            ) +
            line('event_msg', { type: 'task_complete', turn_id: 'a' }, 1300)
        ),
        appendFile(
          betaPath,
          line('event_msg', { type: 'agent_message', id: 'b-note', message: 'Beta note.' }, 2100) +
            line(
              'event_msg',
              { type: 'agent_message', id: 'b-final', message: 'Beta final.' },
              2200
            ) +
            line('event_msg', { type: 'task_complete', turn_id: 'b' }, 2300)
        )
      ])
      await vi.waitFor(() => {
        const replies = service
          .listMessages(room.id, null)
          .messages.filter((message) => message.actorKind === 'agent')
        expect(replies).toHaveLength(2)
        const alpha = replies.find((message) => message.senderIdentity === 'alpha')
        const beta = replies.find((message) => message.senderIdentity === 'beta')
        expect(alpha?.metadata.activity).toMatchObject({
          messages: [expect.objectContaining({ id: 'a-note' })]
        })
        expect(beta?.metadata.activity).toMatchObject({
          messages: [expect.objectContaining({ id: 'b-note' })]
        })
        expect(JSON.stringify(alpha?.metadata.activity)).not.toContain('b-note')
        expect(JSON.stringify(beta?.metadata.activity)).not.toContain('a-note')
      })
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
