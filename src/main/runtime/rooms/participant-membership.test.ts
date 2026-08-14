import { expect, it, vi } from 'vitest'
import { ROOM_CORE_METHODS } from '../rpc/methods/rooms-core'
import type { RoomHarnessRuntime } from './harness-adapter'
import { RoomService } from './service'

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
    waitForTerminal: unused,
    listRoomRunningAgents: async () => [],
    listRoomExistingAgents: async () => [],
    resolveRoomHistoricalSession: unused,
    stageRoomAttachment: unused
  }
}

it('rolls back a failed new participant and its process', async () => {
  const harness = runtime()
  harness.createAgentSession = vi.fn(async () => ({
    terminal: {
      handle: 'term-failed',
      paneKey: 'pane-failed',
      worktreeId: 'worktree-1',
      title: null
    },
    disposition: 'created' as const
  }))
  harness.waitForTerminalAgentInputReady = vi.fn(async () => false)
  harness.getTerminalAgentStatus = vi.fn(async (handle) => ({
    handle,
    isRunningAgent: true,
    status: 'idle' as const
  }))
  harness.closeTerminal = vi.fn(async (handle) => ({
    handle,
    tabId: 'pane-failed',
    ptyKilled: true
  }))
  const service = new RoomService(':memory:', harness)
  const room = service.createRoom({ projectId: 'worktree-1', name: 'Research' }).room

  await expect(
    service.addParticipant({
      roomId: room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      connection: { kind: 'new', worktreeId: 'worktree-1' }
    })
  ).rejects.toThrow('room_agent_not_ready')

  expect(service.db.participants.list(room.id)).toHaveLength(1)
  expect(harness.closeTerminal).toHaveBeenCalledWith('term-failed', {
    force: true,
    waitForExit: true
  })
  service.close()
})

it('keeps a live history selection visible when Existing finds its PTY', async () => {
  const harness = runtime()
  harness.resolveRoomHistoricalSession = vi.fn(async () => ({
    key: 'session_id' as const,
    id: 'session-live'
  }))
  harness.listRoomRunningAgents = vi.fn(async () => [
    {
      agent: 'codex' as const,
      worktreeId: 'worktree-1',
      terminalHandle: 'term-live',
      paneKey: 'pane-live',
      title: 'Codex',
      providerSession: { key: 'session_id' as const, id: 'session-live' }
    }
  ])
  harness.hasPersistedTerminalSurface = () => true
  harness.getTerminalAgentStatus = vi.fn(async (handle) => ({
    handle,
    isRunningAgent: true,
    status: 'idle' as const
  }))
  const service = new RoomService(':memory:', harness)
  const room = service.createRoom({ projectId: 'worktree-1', name: 'Research' }).room

  const participant = await service.addParticipant({
    roomId: room.id,
    identity: 'codex',
    displayName: 'Codex',
    agent: 'codex',
    connection: { kind: 'existing', worktreeId: 'worktree-1', historyId: 'history-live' }
  })

  expect(participant).toMatchObject({
    terminalHandle: 'term-live',
    paneKey: 'pane-live',
    terminalSurfaceVisible: true
  })
  service.close()
})

it('keeps ownership when participant process stop is unconfirmed', async () => {
  const harness = runtime()
  harness.closeTerminal = vi.fn(async (handle) => ({
    handle,
    tabId: 'pane-live',
    ptyKilled: false
  }))
  harness.listRoomRunningAgents = vi.fn(async () => [
    {
      agent: 'codex' as const,
      worktreeId: 'worktree-1',
      terminalHandle: 'term-live',
      paneKey: 'pane-live',
      title: 'Codex',
      providerSession: { key: 'session_id' as const, id: 'session-live' }
    }
  ])
  const service = new RoomService(':memory:', harness)
  const room = service.createRoom({ projectId: 'worktree-1', name: 'Research' }).room
  const participant = service.db.participants.add({
    roomId: room.id,
    identity: 'codex',
    displayName: 'Codex',
    agent: 'codex',
    worktreeId: 'worktree-1',
    terminalHandle: 'term-live',
    paneKey: 'pane-live',
    providerSession: { key: 'session_id', id: 'session-live' }
  })

  await expect(service.removeParticipant(participant.id)).rejects.toThrow(
    'room_agent_stop_unconfirmed'
  )
  expect(service.db.participants.get(participant.id)).toBeDefined()
  service.close()
})

it('removes a sleeping participant whose process is already absent', async () => {
  const harness = runtime()
  harness.closeTerminal = vi.fn(async () => {
    throw new Error('terminal_handle_stale')
  })
  const service = new RoomService(':memory:', harness)
  const room = service.createRoom({ projectId: 'worktree-1', name: 'Research' }).room
  const participant = service.db.participants.add({
    roomId: room.id,
    identity: 'codex',
    displayName: 'Codex',
    agent: 'codex',
    worktreeId: 'worktree-1',
    terminalHandle: 'term-stale',
    paneKey: 'pane-stale',
    providerSession: { key: 'session_id', id: 'session-stale' }
  })
  service.db.participants.update(participant.id, { state: 'sleeping' })

  await service.removeParticipant(participant.id)

  expect(() => service.db.participants.get(participant.id)).toThrow('room_participant_not_found')
  service.close()
})

it('omits sessions already owned by a room from Existing', async () => {
  const harness = runtime()
  harness.listRoomExistingAgents = vi.fn(async () => [
    {
      id: 'owned',
      agent: 'codex' as const,
      title: 'Owned',
      status: 'history' as const,
      model: null,
      updatedAt: null,
      providerSession: {
        key: 'session_id' as const,
        id: 'conversation-owned',
        transport: 'machine' as const,
        sourceSessionId: 'session-owned'
      },
      conversationId: '00000000-0000-4000-8000-000000000001'
    },
    {
      id: 'free',
      agent: 'codex' as const,
      title: 'Free',
      status: 'history' as const,
      model: null,
      updatedAt: null,
      providerSession: { key: 'session_id' as const, id: 'session-free' },
      historyId: 'free'
    }
  ])
  const service = new RoomService(':memory:', harness)
  const room = service.createRoom({ projectId: 'worktree-1', name: 'Research' }).room
  service.db.participants.add({
    roomId: room.id,
    identity: 'codex',
    displayName: 'Codex',
    agent: 'codex',
    worktreeId: 'worktree-1',
    providerSession: { key: 'session_id', id: 'session-owned' }
  })
  const method = ROOM_CORE_METHODS.find(
    (candidate) => candidate.name === 'rooms.participants.existing'
  )

  const result = await (
    method as unknown as {
      handler: (params: unknown, context: unknown) => Promise<{ participants: { id: string }[] }>
    }
  ).handler(
    { worktreeId: 'worktree-1', agent: 'codex' },
    {
      runtime: {
        getRoomService: () => service,
        listRoomExistingAgents: harness.listRoomExistingAgents
      }
    }
  )

  expect(result.participants).toMatchObject([{ id: 'free' }])
  service.close()
})
