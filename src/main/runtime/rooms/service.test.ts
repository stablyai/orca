import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_ROOM_CONTEXT } from '../../../shared/rooms'
import { ROOM_CORE_METHODS } from '../rpc/methods/rooms-core'
import { ROOM_MANAGEMENT_METHODS } from '../rpc/methods/rooms-management'
import type { RoomHarnessRuntime } from './harness-adapter'
import { RoomService } from './service'

const ROOM_METHODS = [...ROOM_CORE_METHODS, ...ROOM_MANAGEMENT_METHODS]

function ensuredSession(handle: string, paneKey: string, disposition: 'adopted' | 'created') {
  return { terminal: { handle, paneKey, worktreeId: 'worktree-1', title: null }, disposition }
}

function runtime(): RoomHarnessRuntime {
  const unused = async (): Promise<never> => {
    throw new Error('unused')
  }
  return {
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
      condition: 'tui-idle' as const,
      satisfied: true,
      status: 'running' as const,
      exitCode: null
    }),
    listRoomAttachableAgents: async () => [],
    resolveRoomHistoricalSession: unused,
    stageRoomAttachment: vi.fn(async (_worktreeId, _handle, attachment) =>
      join(tmpdir(), attachment.fileName)
    )
  }
}

describe('RoomService archive lifecycle', () => {
  it('restores persisted room agents when terminal handles changed after restart', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('terminal_handle_stale'))
      .mockResolvedValue({ handle: 'term-new', isRunningAgent: true, status: 'idle' })
    harness.ensureAgentSession = vi.fn(async () => ensuredSession('term-new', 'tab:new', 'adopted'))
    const service = new RoomService(':memory:', harness)
    const room = service.createRoom({
      projectId: 'project-1',
      name: 'Research',
      description: 'Weather lab'
    }).room
    const providerSession = { key: 'session_id' as const, id: 'session-1' }
    const participant = service.db.participants.add({
      roomId: room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:old',
      terminalHandle: 'term-old',
      providerSession
    })
    // The previous process already received the full configuration.
    service.db.deliveryConfiguration.commit(participant.id, {
      providerSessionKey: providerSession.key,
      providerSessionId: providerSession.id,
      description: 'Weather lab',
      roleRevision: ''
    })

    harness.waitForTerminal = vi.fn(async () => {
      throw new Error('timeout')
    })

    await service.activateRoom(room.id)

    expect(harness.ensureAgentSession).toHaveBeenCalledWith({
      kind: 'explicit',
      worktree: 'id:worktree-1',
      agent: 'codex',
      providerSession,
      // Interactive codex nudges deadlock an unwatched room pane.
      extraAgentArgs:
        '-c notice.hide_rate_limit_model_nudge=true -c check_for_update_on_startup=false',
      launchPreferences: undefined,
      presentation: 'background'
    })
    // Unknown incarnation history (pre-migration rows, transient nulls) keeps
    // the legacy trust: no readiness proof, no configuration resend.
    expect(harness.waitForTerminal).not.toHaveBeenCalled()
    expect(service.db.participants.get(participant.id)).toMatchObject({
      terminalHandle: 'term-new',
      paneKey: 'tab:new',
      state: 'online'
    })
    const { configuration } = service.db.deliveryConfiguration.pending({
      participant: service.db.participants.get(participant.id),
      room: service.db.core.get(room.id),
      role: null
    })
    expect(configuration).toEqual({})
    service.close()
  })

  it('re-proves readiness without resending config when the same provider session restarts', async () => {
    const harness = runtime()
    harness.getTerminalProcessIncarnation = () => 'pty:new'
    harness.getTerminalAgentStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('terminal_handle_stale'))
      // The restarted process is alive but stays busy: readiness needs the waiter.
      .mockResolvedValue({ handle: 'term-new', isRunningAgent: true, status: 'working' })
    harness.ensureAgentSession = vi.fn(async () => ensuredSession('term-new', 'tab:new', 'adopted'))
    harness.waitForTerminal = vi.fn(async () => {
      throw new Error('timeout')
    })
    const service = new RoomService(':memory:', harness)
    const room = service.createRoom({
      projectId: 'project-1',
      name: 'Research',
      description: 'Weather lab'
    }).room
    const providerSession = { key: 'session_id' as const, id: 'session-1' }
    const participant = service.db.participants.add({
      roomId: room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:old',
      terminalHandle: 'term-old',
      providerSession,
      processIncarnation: 'pty:old'
    })
    service.db.deliveryConfiguration.commit(participant.id, {
      providerSessionKey: providerSession.key,
      providerSessionId: providerSession.id,
      description: 'Weather lab',
      roleRevision: ''
    })

    await service.activateRoom(room.id)

    // Known-old vs known-new incarnation is a proven restart, so the bounded
    // waiter runs once. The resumed provider session already owns its context.
    expect(harness.waitForTerminal).toHaveBeenCalledTimes(1)
    expect(service.db.participants.get(participant.id)).toMatchObject({
      terminalHandle: 'term-new',
      state: 'online',
      processIncarnation: 'pty:new'
    })
    const { configuration } = service.db.deliveryConfiguration.pending({
      participant: service.db.participants.get(participant.id),
      room: service.db.core.get(room.id),
      role: null
    })
    expect(configuration).toEqual({})
    service.close()
  })

  it('keeps room configuration delivered when reconfiguring the same provider session', async () => {
    const harness = runtime()
    harness.closeTerminal = vi.fn(async (handle) => ({ handle, tabId: 'tab:old', ptyKilled: true }))
    harness.ensureAgentSession = vi.fn(async () => ensuredSession('term-new', 'tab:new', 'created'))
    harness.getTerminalAgentStatus = vi.fn(async (handle) => ({
      handle,
      isRunningAgent: true,
      status: 'idle' as const
    }))
    const service = new RoomService(':memory:', harness)
    const room = service.createRoom({
      projectId: 'project-1',
      name: 'Research',
      description: 'Weather lab'
    }).room
    const providerSession = { key: 'session_id' as const, id: 'session-1' }
    const participant = service.db.participants.add({
      roomId: room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:old',
      terminalHandle: 'term-old',
      providerSession
    })
    service.db.deliveryConfiguration.commit(participant.id, {
      providerSessionKey: providerSession.key,
      providerSessionId: providerSession.id,
      description: 'Weather lab',
      roleRevision: ''
    })

    await service.reconfigureParticipant(participant.id, { effort: 'high' })

    const current = service.db.participants.get(participant.id)
    expect(current.providerSession).toEqual(providerSession)
    expect(
      service.db.deliveryConfiguration.pending({
        participant: current,
        room: service.db.core.get(room.id),
        role: null
      }).configuration
    ).toEqual({})
    service.close()
  })

  it('evicts a dead adopted session and relaunches instead of pasting into a shell', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi.fn(async (handle: string) => {
      if (handle === 'term-old') {
        throw new Error('terminal_handle_stale')
      }
      // The zombie pane wears the agent's leftover title over a bare shell.
      return handle === 'term-zombie'
        ? { handle, isRunningAgent: false, status: null }
        : { handle, isRunningAgent: true, status: 'idle' as const }
    })
    harness.ensureAgentSession = vi
      .fn()
      // A stale provider-session claim offers a pane whose agent already died.
      .mockResolvedValueOnce(ensuredSession('term-zombie', 'tab:zombie', 'adopted'))
      .mockResolvedValueOnce(ensuredSession('term-fresh', 'tab:fresh', 'created'))
    harness.closeTerminal = vi.fn(async (handle: string) => ({
      handle,
      tabId: 'tab',
      ptyKilled: true
    }))
    const service = new RoomService(':memory:', harness)
    const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
    const participant = service.db.participants.add({
      roomId: room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:old',
      terminalHandle: 'term-old',
      providerSession: { key: 'session_id', id: 'session-1' }
    })

    await service.activateRoom(room.id)

    expect(harness.closeTerminal).toHaveBeenCalledWith('term-zombie', { force: true })
    expect(service.db.participants.get(participant.id)).toMatchObject({
      terminalHandle: 'term-fresh',
      paneKey: 'tab:fresh',
      state: 'online'
    })
    service.close()
  })

  it('returns the room snapshot without waiting for harness activation', async () => {
    const snapshotMethod = ROOM_METHODS.find((method) => method.name === 'rooms.snapshot')
    const service = {
      snapshot: vi.fn(() => ({ room: { id: 'room-1' } })),
      activateRoom: vi.fn(() => new Promise(() => {}))
    }
    const result = await (
      snapshotMethod as unknown as {
        handler: (params: unknown, context: unknown) => Promise<{ snapshot: unknown }>
      }
    ).handler(
      { roomId: crypto.randomUUID(), readerKey: 'user' },
      { runtime: { getRoomService: () => service } }
    )
    // The header renders from persisted state; reconciliation streams events.
    expect(result.snapshot).toEqual({ room: { id: 'room-1' } })
    expect(service.activateRoom).toHaveBeenCalledTimes(1)
  })

  it('trusts the same harness process on restore without waiting or resending config', async () => {
    const harness = runtime()
    harness.getTerminalProcessIncarnation = () => 'pty:7'
    harness.getTerminalAgentStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('terminal_handle_stale'))
      .mockResolvedValue({ handle: 'term-new', isRunningAgent: true, status: 'idle' })
    harness.ensureAgentSession = vi.fn(async () => ensuredSession('term-new', 'tab:new', 'adopted'))
    harness.waitForTerminal = vi.fn(async () => {
      throw new Error('timeout')
    })
    const service = new RoomService(':memory:', harness)
    const room = service.createRoom({
      projectId: 'project-1',
      name: 'Research',
      description: 'Weather lab'
    }).room
    const providerSession = { key: 'session_id' as const, id: 'session-1' }
    const participant = service.db.participants.add({
      roomId: room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:old',
      terminalHandle: 'term-old',
      providerSession,
      processIncarnation: 'pty:7'
    })
    service.db.deliveryConfiguration.commit(participant.id, {
      providerSessionKey: providerSession.key,
      providerSessionId: providerSession.id,
      description: 'Weather lab',
      roleRevision: ''
    })

    await service.activateRoom(room.id)

    expect(service.db.participants.get(participant.id)).toMatchObject({
      terminalHandle: 'term-new',
      state: 'online',
      processIncarnation: 'pty:7'
    })
    // Same process the room already bound to: no readiness proof, no config resend.
    expect(harness.waitForTerminal).not.toHaveBeenCalled()
    const { configuration } = service.db.deliveryConfiguration.pending({
      participant: service.db.participants.get(participant.id),
      room: service.db.core.get(room.id),
      role: null
    })
    expect(configuration).toEqual({})
    service.close()
  })

  it('reapplies restart-scoped launch preferences from the room context on restore', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi.fn(async (handle: string) => {
      if (handle.startsWith('term-old')) {
        throw new Error('terminal_handle_stale')
      }
      return { handle, isRunningAgent: true, status: 'idle' as const }
    })
    harness.ensureAgentSession = vi.fn(async (request) => ({
      terminal: {
        handle: `term-new-${request.kind === 'explicit' ? request.agent : 'automatic'}`,
        paneKey: `tab:new-${request.kind === 'explicit' ? request.agent : 'automatic'}`,
        worktreeId: 'worktree-1',
        title: null
      },
      disposition: 'adopted' as const
    }))
    const service = new RoomService(':memory:', harness)
    const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
    const codex = service.db.participants.add({
      roomId: room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:old-codex',
      terminalHandle: 'term-old-codex',
      providerSession: { key: 'session_id', id: 'session-codex' }
    })
    service.db.participants.update(codex.id, {
      context: {
        ...EMPTY_ROOM_CONTEXT,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        fastMode: true
      }
    })
    const claude = service.db.participants.add({
      roomId: room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude',
      worktreeId: 'worktree-1',
      paneKey: 'tab:old-claude',
      terminalHandle: 'term-old-claude',
      providerSession: { key: 'session_id', id: 'session-claude' }
    })
    service.db.participants.update(claude.id, {
      context: { ...EMPTY_ROOM_CONTEXT, model: 'claude-opus-5[1m]', effort: 'high' }
    })

    await service.activateRoom(room.id)

    const requests = vi
      .mocked(harness.ensureAgentSession)
      .mock.calls.map(([request]) => request)
      .filter((request) => request.kind === 'explicit')
    const codexRequest = requests.find((request) => request.agent === 'codex')
    // Codex loses launch-scoped settings on restart: the room-tracked values are re-applied.
    expect(codexRequest?.launchPreferences).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      mode: 'fast'
    })
    const claudeRequest = requests.find((request) => request.agent === 'claude')
    expect(claudeRequest).toBeDefined()
    // Claude persists them in the session itself; nothing is restart-scoped.
    expect(claudeRequest?.launchPreferences).toBeUndefined()
    service.close()
  })

  it('relaunches a zero-turn room agent when its persisted terminal handle is stale', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('terminal_handle_stale'))
      .mockResolvedValue({ handle: 'term-new', isRunningAgent: true, status: 'idle' })
    harness.createAgentSession = vi.fn(async () => ({
      terminal: {
        handle: 'term-new',
        paneKey: 'tab:new',
        worktreeId: 'worktree-1',
        title: null
      },
      disposition: 'created' as const
    }))
    const service = new RoomService(':memory:', harness)
    const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
    const participant = service.db.participants.add({
      roomId: room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:old',
      terminalHandle: 'term-old'
    })

    await service.activateRoom(room.id)

    expect(harness.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree: 'id:worktree-1',
        agent: 'codex',
        presentation: 'background',
        viewMode: 'chat'
      })
    )
    expect(service.db.participants.get(participant.id)).toMatchObject({
      terminalHandle: 'term-new',
      paneKey: 'tab:new',
      providerSession: null,
      state: 'online'
    })
    service.close()
  })

  it('keeps a relaunched room agent starting until the harness reports ready', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('terminal_handle_stale'))
      // The fresh CLI is still booting when readiness is first probed.
      .mockResolvedValueOnce({ handle: 'term-new', isRunningAgent: false, status: null })
      .mockResolvedValue({ handle: 'term-new', isRunningAgent: true, status: 'idle' })
    harness.createAgentSession = vi.fn(async () => ({
      terminal: {
        handle: 'term-new',
        paneKey: 'tab:new',
        worktreeId: 'worktree-1',
        title: null
      },
      disposition: 'created' as const
    }))
    // Readiness resolves through the runtime's idle-title waiter, not polling.
    let releaseReady!: () => void
    harness.waitForTerminal = vi.fn(
      (handle: string) =>
        new Promise<Awaited<ReturnType<RoomHarnessRuntime['waitForTerminal']>>>((resolve) => {
          releaseReady = () =>
            resolve({
              handle,
              condition: 'tui-idle' as const,
              satisfied: true,
              status: 'running' as const,
              exitCode: null
            })
        })
    )
    const service = new RoomService(':memory:', harness)
    const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
    const participant = service.db.participants.add({
      roomId: room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:old',
      terminalHandle: 'term-old'
    })

    try {
      const activation = service.activateRoom(room.id)
      await vi.waitFor(() => {
        expect(service.db.participants.get(participant.id).state).toBe('starting')
      })
      releaseReady()
      await activation
      expect(service.db.participants.get(participant.id).state).toBe('online')
    } finally {
      service.close()
    }
  })

  it('serializes current-event deliveries on confirmed provider turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-delivery-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeFile(transcriptPath, '')
    const transcriptLine = (
      type: string,
      payload: Record<string, unknown>,
      timestamp: number
    ): string =>
      `${JSON.stringify({ type, timestamp: new Date(timestamp).toISOString(), payload })}\n`
    const harness = runtime()
    harness.sendTerminalAgentPrompt = vi.fn(async (handle, prompt) => ({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(prompt)
    }))
    harness.getTerminalAgentStatus = vi.fn(async (handle) => ({
      handle,
      isRunningAgent: true,
      status: 'idle' as const
    }))
    const service = new RoomService(':memory:', harness)
    try {
      const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
      const user = snapshot.participants[0]
      const codex = service.db.participants.add({
        roomId: snapshot.room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex',
        worktreeId: 'worktree-1',
        paneKey: 'tab:codex',
        terminalHandle: 'term-codex',
        providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
      })
      await service.activateRoom(snapshot.room.id)
      const first = await service.sendMessage({
        roomId: snapshot.room.id,
        senderIdentity: user.identity,
        body: '@codex first request',
        mentions: ['codex']
      })
      const firstDelivery = service.db.messages.deliveries.listForMessage(first.id)[0]
      const send = vi.mocked(harness.sendTerminalAgentPrompt)
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledTimes(1)
        // A PTY write is not a confirmation: the delivery waits for its provider turn.
        expect(service.db.messages.deliveries.get(firstDelivery.id).state).toBe('delivering')
      })
      const firstPrompt = send.mock.calls[0][1]
      expect(firstPrompt).not.toContain('room-context-ref')
      expect(firstPrompt).toContain('response="required"')
      expect(firstPrompt.match(/@codex first request/gu)).toHaveLength(1)

      // A queued mention must stay pending while the previous delivery is in flight.
      const second = await service.sendMessage({
        roomId: snapshot.room.id,
        senderIdentity: user.identity,
        body: '@codex second request',
        mentions: ['codex']
      })
      const secondDelivery = service.db.messages.deliveries.listForMessage(second.id)[0]

      // Simultaneous direct CLI input opens a turn that must not confirm the delivery.
      await appendFile(
        transcriptPath,
        transcriptLine(
          'event_msg',
          { type: 'user_message', id: 'direct-1', message: '2+2?' },
          100
        ) +
          transcriptLine(
            'event_msg',
            { type: 'agent_message', id: 'direct-a', message: '4.' },
            200
          ) +
          transcriptLine('event_msg', { type: 'task_complete', turn_id: 'direct' }, 300)
      )
      await vi.waitFor(() => {
        expect(service.db.participants.get(codex.id).lastSeenAt).toBe(300)
      })
      expect(service.db.messages.deliveries.get(firstDelivery.id).state).toBe('delivering')
      expect(service.db.messages.deliveries.get(secondDelivery.id).state).toBe('pending')
      expect(
        service
          .listMessages(snapshot.room.id, null)
          .messages.filter((message) => message.actorKind === 'agent')
      ).toEqual([])

      // The delivery's own prompt turn confirms it and records the turn id.
      await appendFile(
        transcriptPath,
        transcriptLine(
          'event_msg',
          { type: 'user_message', id: 'prompt-1', message: firstPrompt },
          400
        )
      )
      await vi.waitFor(
        () => {
          const confirmed = service.db.messages.deliveries.get(firstDelivery.id)
          expect(confirmed.state).toBe('delivered')
          expect(confirmed.providerTurnId).toBe('prompt-1')
        },
        { timeout: 5_000 }
      )
      expect(service.db.messages.deliveries.get(secondDelivery.id).state).toBe('pending')

      // The turn's final answer publishes into the room and unblocks the queue.
      await appendFile(
        transcriptPath,
        transcriptLine(
          'event_msg',
          { type: 'agent_message', id: 'answer-1', message: 'First reviewed.' },
          500
        ) + transcriptLine('event_msg', { type: 'task_complete', turn_id: 'turn-1' }, 600)
      )
      await vi.waitFor(
        () => {
          expect(
            service.db.messages.deliveries.get(firstDelivery.id).responseMessageId
          ).not.toBeNull()
          expect(send).toHaveBeenCalledTimes(2)
        },
        { timeout: 5_000 }
      )
      const reply = service
        .listMessages(snapshot.room.id, null)
        .messages.find((message) => message.actorKind === 'agent')
      expect(reply?.body).toBe('First reviewed.')
      expect(reply?.replyToId).toBe(first.id)

      const secondPrompt = send.mock.calls[1][1]
      expect(secondPrompt).not.toContain('first request')
      expect(secondPrompt.match(/@codex second request/gu)).toHaveLength(1)
      await appendFile(
        transcriptPath,
        transcriptLine(
          'event_msg',
          { type: 'user_message', id: 'prompt-2', message: secondPrompt },
          700
        )
      )
      await vi.waitFor(() => {
        const confirmed = service.db.messages.deliveries.get(secondDelivery.id)
        expect(confirmed.state).toBe('delivered')
        expect(confirmed.providerTurnId).toBe('prompt-2')
      })
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('confirms a delivery whose turn is first observed as a replayed snapshot', async () => {
    // A freshly launched Claude reports its session only with the first prompt,
    // so the watcher starts after the delivery turn already began.
    const root = await mkdtemp(join(tmpdir(), 'orca-room-replay-confirm-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    const transcriptLine = (
      type: string,
      payload: Record<string, unknown>,
      timestamp: number
    ): string =>
      `${JSON.stringify({ type, timestamp: new Date(timestamp).toISOString(), payload })}\n`
    const harness = runtime()
    harness.sendTerminalAgentPrompt = vi.fn(async (handle, prompt) => ({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(prompt)
    }))
    harness.getTerminalAgentStatus = vi.fn(async (handle) => ({
      handle,
      isRunningAgent: true,
      status: 'idle' as const
    }))
    const service = new RoomService(':memory:', harness)
    try {
      const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
      const user = snapshot.participants[0]
      // No provider session yet: the transcript watcher cannot start.
      const codex = service.db.participants.add({
        roomId: snapshot.room.id,
        identity: 'codex',
        displayName: 'Codex',
        agent: 'codex',
        worktreeId: 'worktree-1',
        paneKey: 'tab:codex',
        terminalHandle: 'term-codex'
      })
      const prompt = await service.sendMessage({
        roomId: snapshot.room.id,
        senderIdentity: user.identity,
        body: '@codex introduce yourself',
        mentions: ['codex']
      })
      const delivery = service.db.messages.deliveries.listForMessage(prompt.id)[0]
      const send = vi.mocked(harness.sendTerminalAgentPrompt)
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledTimes(1)
        expect(service.db.messages.deliveries.get(delivery.id).state).toBe('delivering')
      })

      // The turn (and even its final answer) lands before the watcher starts.
      await writeFile(
        transcriptPath,
        transcriptLine(
          'event_msg',
          { type: 'user_message', id: 'prompt-1', message: send.mock.calls[0][1] },
          100
        ) +
          transcriptLine('event_msg', { type: 'task_started', turn_id: 'turn-1' }, 150) +
          transcriptLine(
            'event_msg',
            { type: 'agent_message', id: 'answer-1', message: 'Hello, I am Codex.' },
            200
          ) +
          transcriptLine('event_msg', { type: 'task_complete', turn_id: 'turn-1' }, 300)
      )
      service.db.participants.update(codex.id, {
        providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
      })
      await service.activateRoom(snapshot.room.id)

      await vi.waitFor(() => {
        const confirmed = service.db.messages.deliveries.get(delivery.id)
        expect(confirmed.state).toBe('delivered')
        expect(confirmed.providerTurnId).toBe('prompt-1')
        expect(confirmed.responseMessageId).not.toBeNull()
      })
      const reply = service
        .listMessages(snapshot.room.id, null)
        .messages.find((message) => message.actorKind === 'agent')
      expect(reply?.body).toBe('Hello, I am Codex.')
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    [
      'rooms.messages.send',
      {
        roomId: crypto.randomUUID(),
        body: 'x',
        senderIdentity: 'agent'
      }
    ],
    [
      'rooms.pins.set',
      {
        roomId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        status: 'todo',
        createdBy: 'agent'
      }
    ]
  ])('rejects renderer-controlled actor attribution for %s', (name, params) => {
    const method = ROOM_METHODS.find((candidate) => candidate.name === name)
    expect(method?.params?.safeParse(params).success).toBe(false)
  })
})
