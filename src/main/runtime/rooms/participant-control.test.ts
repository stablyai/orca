import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
    waitForTerminal: async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }),
    listRoomAttachableAgents: async () => [],
    resolveRoomHistoricalSession: unused,
    stageRoomAttachment: unused
  }
}

describe('room participant controls', () => {
  it('reports the live model and accepts only catalog-backed controls', async () => {
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
    const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
    const participant = service.db.participants.add({
      roomId: room.id,
      identity: 'claude',
      displayName: 'Claude',
      agent: 'claude',
      worktreeId: 'worktree-1',
      paneKey: 'tab:claude',
      terminalHandle: 'term-claude',
      providerSession: { key: 'session_id', id: 'session-claude' }
    })

    service.ingestAgentStatus({
      connectionId: 'connection-1',
      paneKey: participant.paneKey!,
      payload: { state: 'done', prompt: '', agentType: 'claude', model: 'opus' },
      receivedAt: 10
    })
    expect(service.db.participants.get(participant.id).context.model).toBe('opus')

    await service.controlParticipant(participant.id, '/effort xhigh')
    expect(harness.getTerminalAgentStatus).toHaveBeenCalledWith('term-claude', {
      confirmForeground: true
    })
    expect(harness.sendTerminalAgentPrompt).toHaveBeenCalledWith('term-claude', '/effort xhigh')
    service.ingestAgentStatus({
      paneKey: participant.paneKey!,
      connectionId: null,
      hookEventName: 'PreToolUse',
      receivedAt: 11,
      payload: {
        state: 'working',
        prompt: '',
        agentType: 'claude',
        toolName: 'Read',
        toolInput: 'src/app.ts'
      }
    })
    service.ingestAgentStatus({
      paneKey: participant.paneKey!,
      connectionId: null,
      hookEventName: 'Stop',
      receivedAt: 12,
      payload: {
        state: 'done',
        prompt: '',
        agentType: 'claude',
        lastAssistantMessage: 'Model changed.'
      }
    })
    expect(service.snapshot(room.id).activities).toEqual([])
    expect(
      service
        .listMessages(room.id, null)
        .messages.filter((message) => message.actorKind === 'agent')
    ).toEqual([])
    await expect(service.controlParticipant(participant.id, '/help')).rejects.toThrow(
      'room_agent_control_unsupported'
    )
    service.close()
  })

  it('cancels Claude transient UI and confirms Fast mode from its transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-room-fast-control-'))
    const transcriptPath = join(root, 'claude.jsonl')
    await writeFile(transcriptPath, '')
    const harness = runtime()
    harness.sendTerminal = vi.fn(async (handle, action) => ({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(action.text ?? '')
    }))
    harness.sendTerminalAgentPrompt = vi.fn(async (handle, prompt) => {
      await appendFile(
        transcriptPath,
        `${JSON.stringify({
          type: 'user',
          timestamp: new Date(Date.now() + 1_000).toISOString(),
          message: { content: '<local-command-stdout>Fast mode OFF</local-command-stdout>' }
        })}\n`
      )
      return { handle, accepted: true, bytesWritten: Buffer.byteLength(prompt) }
    })
    harness.getTerminalAgentStatus = vi.fn(async (handle) => ({
      handle,
      isRunningAgent: true,
      status: 'idle' as const
    }))
    const service = new RoomService(':memory:', harness)
    try {
      const room = service.createRoom({ projectId: 'project-1', name: 'Research' }).room
      const participant = service.db.participants.add({
        roomId: room.id,
        identity: 'claude',
        displayName: 'Claude',
        agent: 'claude',
        worktreeId: 'worktree-1',
        paneKey: 'tab:claude',
        terminalHandle: 'term-claude',
        providerSession: { key: 'session_id', id: 'session-claude', transcriptPath }
      })

      const updated = await service.controlParticipant(participant.id, '/fast off')

      expect(updated.context.fastMode).toBe(false)
      expect(harness.sendTerminal).toHaveBeenCalledWith('term-claude', { text: '\x1b' })
      expect(harness.sendTerminalAgentPrompt).toHaveBeenCalledWith('term-claude', '/fast off')
    } finally {
      service.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
