import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import type { RoomHarnessRuntime } from './harness-adapter'
import { ROOM_AGENT_IDLE_SLEEP_MS } from './participant-controller'
import { RoomService } from './service'

function runtime(): RoomHarnessRuntime {
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
    stageRoomAttachment: unused
  }
}

function agentParticipant(
  service: RoomService,
  roomId: string,
  identity: string,
  transcriptPath?: string
) {
  const participant = service.db.participants.add({
    roomId,
    identity,
    displayName: identity,
    agent: 'codex',
    worktreeId: 'worktree-1',
    paneKey: `tab:${identity}`,
    terminalHandle: `term-${identity}`,
    providerSession: {
      key: 'session_id',
      id: `session-${identity}`,
      ...(transcriptPath ? { transcriptPath } : {})
    }
  })
  return service.db.participants.update(participant.id, { state: 'online' })
}

const afterIdleWindow = (): number => Date.now() + ROOM_AGENT_IDLE_SLEEP_MS + 60_000

describe('room participant hibernation', () => {
  it('does not hibernate an agent whose terminal surface is visible', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi.fn()
    harness.closeTerminal = vi.fn()
    const service = new RoomService(':memory:', harness)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const visible = agentParticipant(service, snapshot.room.id, 'visible')
    service.db.participants.update(visible.id, { terminalSurfaceVisible: true })

    await service.participantController.hibernateIdle(afterIdleWindow())

    expect(harness.getTerminalAgentStatus).not.toHaveBeenCalled()
    expect(harness.closeTerminal).not.toHaveBeenCalled()
    expect(service.db.participants.get(visible.id)).toMatchObject({
      state: 'online',
      terminalSurfaceVisible: true
    })
    service.close()
  })

  it('stops only provably idle agents without in-flight deliveries', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi.fn(async (handle: string) => ({
      handle,
      isRunningAgent: true,
      status: handle === 'term-busy' ? ('working' as const) : ('idle' as const)
    }))
    harness.closeTerminal = vi.fn(async (handle: string) => ({
      handle,
      tabId: 'tab',
      ptyKilled: true
    }))
    const service = new RoomService(':memory:', harness)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const queued = agentParticipant(service, snapshot.room.id, 'queued')
    const user = snapshot.participants[0]
    service.db.messages.create({
      roomId: snapshot.room.id,
      senderId: user.id,
      senderIdentity: user.identity,
      actorKind: 'user',
      body: '@queued hello',
      mentions: ['queued']
    })
    const idle = agentParticipant(service, snapshot.room.id, 'idle')
    const busy = agentParticipant(service, snapshot.room.id, 'busy')

    await service.participantController.hibernateIdle(afterIdleWindow())

    expect(harness.closeTerminal).toHaveBeenCalledWith('term-idle', {
      force: true,
      waitForExit: true
    })
    expect(harness.closeTerminal).toHaveBeenCalledTimes(1)
    expect(service.db.participants.get(idle.id).state).toBe('sleeping')
    expect(service.db.participants.get(busy.id).state).toBe('online')
    // A pending delivery would wake the agent right back up: keep it running.
    expect(service.db.participants.get(queued.id).state).toBe('online')
    service.close()
  })

  it('sleeps a proven-dead pane but stays online when nothing can be proven', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi.fn(async (handle: string) => {
      if (handle === 'term-unknown') {
        throw new Error('terminal_handle_stale')
      }
      // Foreground-verified shell: the agent is proven gone.
      return { handle, isRunningAgent: false, status: null }
    })
    harness.closeTerminal = vi.fn()
    // The enumeration itself failing means nothing was proven either way.
    harness.listRoomRunningAgents = vi.fn(async () => {
      throw new Error('worktree_unavailable')
    })
    const service = new RoomService(':memory:', harness)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const dead = agentParticipant(service, snapshot.room.id, 'dead')
    const unknown = agentParticipant(service, snapshot.room.id, 'unknown')

    await service.participantController.hibernateIdle(afterIdleWindow())

    expect(harness.closeTerminal).not.toHaveBeenCalled()
    expect(service.db.participants.get(dead.id).state).toBe('sleeping')
    expect(service.db.participants.get(unknown.id).state).toBe('online')
    service.close()
  })

  it('relocates a stale handle after a restart and hibernates the live pane', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi.fn(async (handle: string) => {
      if (handle === 'term-stale') {
        throw new Error('terminal_handle_stale')
      }
      return { handle, isRunningAgent: true, status: 'idle' as const }
    })
    harness.closeTerminal = vi.fn(async (handle: string) => ({
      handle,
      tabId: 'tab',
      ptyKilled: true
    }))
    harness.listRoomRunningAgents = vi.fn(async () => [
      {
        agent: 'codex' as const,
        worktreeId: 'worktree-1',
        terminalHandle: 'term-fresh',
        paneKey: 'tab:stale',
        title: null,
        providerSession: { key: 'session_id' as const, id: 'session-stale' }
      }
    ])
    const service = new RoomService(':memory:', harness)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const stale = agentParticipant(service, snapshot.room.id, 'stale')

    await service.participantController.hibernateIdle(afterIdleWindow())

    expect(harness.closeTerminal).toHaveBeenCalledWith('term-fresh', {
      force: true,
      waitForExit: true
    })
    expect(service.db.participants.get(stale.id)).toMatchObject({
      state: 'sleeping',
      terminalHandle: 'term-fresh'
    })
    service.close()
  })

  it('sleeps a silent pane only when the provider transcript proves idleness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hibernation-'))
    const stalePath = join(dir, 'stale.jsonl')
    const freshPath = join(dir, 'fresh.jsonl')
    writeFileSync(stalePath, '{}\n')
    writeFileSync(freshPath, '{}\n')
    const now = Date.now() + ROOM_AGENT_IDLE_SLEEP_MS + 60_000
    utimesSync(
      stalePath,
      (now - ROOM_AGENT_IDLE_SLEEP_MS - 1000) / 1000,
      (now - ROOM_AGENT_IDLE_SLEEP_MS - 1000) / 1000
    )
    utimesSync(freshPath, (now - 1000) / 1000, (now - 1000) / 1000)
    const harness = runtime()
    // Silent since adoption: alive, but no title or hook evidence exists.
    harness.getTerminalAgentStatus = vi.fn(async (handle: string) => ({
      handle,
      isRunningAgent: true,
      status: null
    }))
    harness.closeTerminal = vi.fn(async (handle: string) => ({
      handle,
      tabId: 'tab',
      ptyKilled: true
    }))
    const service = new RoomService(':memory:', harness)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const stale = agentParticipant(service, snapshot.room.id, 'stale', stalePath)
    const fresh = agentParticipant(service, snapshot.room.id, 'fresh', freshPath)

    try {
      await service.participantController.hibernateIdle(now)

      expect(harness.closeTerminal).toHaveBeenCalledWith('term-stale', {
        force: true,
        waitForExit: true
      })
      expect(harness.closeTerminal).toHaveBeenCalledTimes(1)
      expect(service.db.participants.get(stale.id).state).toBe('sleeping')
      expect(service.db.participants.get(fresh.id).state).toBe('online')
    } finally {
      service.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks sleeping without a stop when no live pane hosts the agent anymore', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi.fn(async () => {
      throw new Error('terminal_handle_stale')
    })
    harness.closeTerminal = vi.fn()
    const service = new RoomService(':memory:', harness)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const gone = agentParticipant(service, snapshot.room.id, 'gone')

    await service.participantController.hibernateIdle(afterIdleWindow())

    expect(harness.closeTerminal).not.toHaveBeenCalled()
    expect(service.db.participants.get(gone.id).state).toBe('sleeping')
    service.close()
  })

  it('marks a running participant sleeping only after its PTY stop is confirmed', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi.fn(async (handle: string) => ({
      handle,
      isRunningAgent: true,
      status: 'idle' as const
    }))
    let finishStop!: () => void
    harness.closeTerminal = vi.fn(
      (handle: string) =>
        new Promise<RuntimeTerminalClose>((resolve) => {
          finishStop = () => resolve({ handle, tabId: 'tab', ptyKilled: true })
        })
    )
    const service = new RoomService(':memory:', harness)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const idle = agentParticipant(service, snapshot.room.id, 'idle')

    const hibernation = service.participantController.hibernateIdle(afterIdleWindow())
    await vi.waitFor(() => expect(harness.closeTerminal).toHaveBeenCalledOnce())
    expect(service.db.participants.get(idle.id).state).toBe('online')

    finishStop()
    await hibernation
    expect(service.db.participants.get(idle.id).state).toBe('sleeping')
    service.close()
  })

  it('keeps a participant online when its PTY stop cannot be confirmed', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi.fn(async (handle: string) => ({
      handle,
      isRunningAgent: true,
      status: 'idle' as const
    }))
    harness.closeTerminal = vi.fn(async (handle: string) => ({
      handle,
      tabId: 'tab',
      ptyKilled: false
    }))
    const service = new RoomService(':memory:', harness)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const idle = agentParticipant(service, snapshot.room.id, 'idle')

    await service.participantController.hibernateIdle(afterIdleWindow())

    expect(service.db.participants.get(idle.id).state).toBe('online')
    service.close()
  })

  it('does not reset the idle clock when reading a room changes nothing', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi.fn(async (handle: string) => ({
      handle,
      isRunningAgent: true,
      status: 'idle' as const
    }))
    harness.closeTerminal = vi.fn(async (handle: string) => ({
      handle,
      tabId: 'tab',
      ptyKilled: true
    }))
    const service = new RoomService(':memory:', harness)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const idle = agentParticipant(service, snapshot.room.id, 'idle')
    const idleSince = service.db.participants.get(idle.id).updatedAt

    // Browsing the room reconciles the live agent without changing anything.
    await service.activateRoom(snapshot.room.id)

    await service.participantController.hibernateIdle(idleSince + ROOM_AGENT_IDLE_SLEEP_MS + 1)
    expect(service.db.participants.get(idle.id).state).toBe('sleeping')
    service.close()
  })

  it('ignores bookkeeping row rewrites when computing idleness', async () => {
    const harness = runtime()
    harness.getTerminalAgentStatus = vi.fn(async (handle: string) => ({
      handle,
      isRunningAgent: true,
      status: 'idle' as const
    }))
    harness.closeTerminal = vi.fn(async (handle: string) => ({
      handle,
      tabId: 'tab',
      ptyKilled: true
    }))
    const service = new RoomService(':memory:', harness)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const idle = agentParticipant(service, snapshot.room.id, 'idle')
    const { createdAt } = service.db.participants.get(idle.id)

    // An Orca restart rebinds handles and rewrites the row; that is not activity.
    service.db.participants.update(idle.id, { terminalHandle: 'term-idle', state: 'online' })

    await service.participantController.hibernateIdle(createdAt + ROOM_AGENT_IDLE_SLEEP_MS + 1)
    expect(service.db.participants.get(idle.id).state).toBe('sleeping')
    service.close()
  })

  it('does not boot a sleeping agent when the room is activated', async () => {
    const harness = runtime()
    harness.ensureAgentSession = vi.fn()
    harness.getTerminalAgentStatus = vi.fn()
    const service = new RoomService(':memory:', harness)
    const snapshot = service.createRoom({ projectId: 'project-1', name: 'Research' })
    const idle = agentParticipant(service, snapshot.room.id, 'idle')
    service.db.participants.update(idle.id, { state: 'sleeping' })

    await service.activateRoom(snapshot.room.id)

    expect(harness.ensureAgentSession).not.toHaveBeenCalled()
    expect(harness.getTerminalAgentStatus).not.toHaveBeenCalled()
    expect(service.db.participants.get(idle.id).state).toBe('sleeping')
    service.close()
  })
})
