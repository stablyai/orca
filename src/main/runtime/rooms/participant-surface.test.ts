import { describe, expect, it, vi } from 'vitest'
import type { RoomParticipant } from '../../../shared/rooms'
import type { RoomParticipantController } from './participant-controller'
import { RoomParticipantSurface } from './participant-surface'

describe('RoomParticipantSurface', () => {
  it('wakes and publishes a machine participant chat', async () => {
    const participant = {
      id: 'participant-1',
      agent: 'codex',
      worktreeId: 'worktree-1',
      providerSession: {
        key: 'session_id',
        id: 'machine-session-1',
        transport: 'machine'
      }
    } as RoomParticipant
    const ensureReady = vi.fn(async () => participant)
    const publish = vi.fn(async () => undefined)
    const surface = new RoomParticipantSurface(
      {} as never,
      { ensureReady } as unknown as RoomParticipantController,
      undefined,
      undefined,
      undefined,
      publish
    )

    await surface.reveal(participant.id, 'chat')

    expect(ensureReady).toHaveBeenCalledWith(participant.id)
    expect(publish).toHaveBeenCalledWith({
      workspaceId: 'worktree-1',
      sessionId: 'machine-session-1',
      agent: 'codex',
      activate: true
    })
  })
})
