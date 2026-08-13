import { expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import type { RoomHarnessRuntime } from './harness-adapter'
import { RoomService } from './service'

it('accepts a fresh composer while restored status still reports working', async () => {
  const unused = async (): Promise<never> => {
    throw new Error('unused')
  }
  let ready = false
  let releaseReady: (() => void) | undefined
  const createAgentSession = vi.fn(async () => ({
    terminal: { handle: 'term-new', paneKey: 'tab:new', worktreeId: 'worktree-1', title: null },
    disposition: 'created' as const
  }))
  const runtime: RoomHarnessRuntime = {
    createAgentSession,
    ensureAgentSession: vi.fn(unused),
    sendTerminalAgentPrompt: vi.fn(async (handle, prompt) => ({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(prompt)
    })),
    waitForTerminalAgentInputReady: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    compactTerminalAgentSession: unused,
    getTerminalAgentStatus: vi.fn(async (handle: string) => ({
      handle,
      isRunningAgent: handle === 'term-new' && ready,
      status: handle === 'term-new' && ready ? ('working' as const) : null
    })),
    getTerminalProcessIncarnation: () => null,
    closeTerminal: unused,
    waitForTerminal: vi.fn(
      (handle) =>
        new Promise<RuntimeTerminalWait>((resolve) => {
          releaseReady = () => {
            ready = true
            resolve({
              handle,
              condition: 'tui-idle' as const,
              satisfied: true,
              status: 'running' as const,
              exitCode: null
            })
          }
        })
    ),
    listRoomRunningAgents: async () => [],
    listRoomExistingAgents: async () => [],
    resolveRoomHistoricalSession: unused,
    stageRoomAttachment: unused
  }
  const service = new RoomService(':memory:', runtime)
  try {
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const added = service.db.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:old',
      terminalHandle: 'term-old',
      providerSession: { key: 'session_id', id: 'unmaterialized-session' }
    })
    const participant = service.db.participants.update(added.id, { state: 'sleeping' })

    await service.sendMessage({
      roomId: snapshot.room.id,
      senderIdentity: snapshot.participants[0].identity,
      body: '@codex wake up',
      mentions: ['codex']
    })
    await vi.waitFor(() => expect(runtime.waitForTerminal).toHaveBeenCalledTimes(1))
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(createAgentSession).toHaveBeenCalledTimes(1)
    expect(runtime.ensureAgentSession).not.toHaveBeenCalled()

    releaseReady?.()
    await vi.waitFor(() => expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalled())
    expect(createAgentSession).toHaveBeenCalledTimes(1)
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term-new',
      expect.stringContaining('<orca-room-delivery id='),
      { beforeWrite: expect.any(Function), clearInput: false }
    )
    expect(service.db.participants.get(participant.id).state).toBe('online')
    expect(service.db.participants.get(participant.id).providerSession).toBeNull()
  } finally {
    service.close()
  }
})

it('accepts composer proof when a live participant has no fresh hook status', async () => {
  const unused = async (): Promise<never> => {
    throw new Error('unused')
  }
  const sendTerminalAgentPrompt = vi.fn(async (handle, prompt) => ({
    handle,
    accepted: true,
    bytesWritten: Buffer.byteLength(prompt)
  }))
  const runtime: RoomHarnessRuntime = {
    createAgentSession: unused,
    ensureAgentSession: unused,
    sendTerminalAgentPrompt,
    waitForTerminalAgentInputReady: vi.fn().mockResolvedValue(true),
    compactTerminalAgentSession: unused,
    getTerminalAgentStatus: vi.fn(async (handle: string) => ({
      handle,
      isRunningAgent: true,
      status: null
    })),
    getTerminalProcessIncarnation: () => null,
    closeTerminal: unused,
    waitForTerminal: unused,
    listRoomRunningAgents: async () => [],
    listRoomExistingAgents: async () => [],
    resolveRoomHistoricalSession: unused,
    stageRoomAttachment: unused
  }
  const service = new RoomService(':memory:', runtime)
  try {
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    service.db.participants.add({
      roomId: snapshot.room.id,
      identity: 'codex',
      displayName: 'Codex',
      agent: 'codex',
      worktreeId: 'worktree-1',
      paneKey: 'tab:codex',
      terminalHandle: 'term-codex'
    })

    await service.sendMessage({
      roomId: snapshot.room.id,
      senderIdentity: snapshot.participants[0].identity,
      body: '@codex ping',
      mentions: ['codex']
    })

    await vi.waitFor(() => expect(sendTerminalAgentPrompt).toHaveBeenCalledTimes(1))
  } finally {
    service.close()
  }
})
