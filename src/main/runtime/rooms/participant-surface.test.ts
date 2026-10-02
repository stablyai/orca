import { roomParticipantFixture } from '../../../shared/rooms.test-fixture'
import { describe, expect, it, vi } from 'vitest'

import { RoomDatabase } from './database'
import { RoomParticipantSurface } from './participant-surface'

describe('RoomParticipantSurface', () => {
  it('wakes and publishes a machine participant chat', async () => {
    const participant = roomParticipantFixture({
      id: 'participant-1',
      agent: 'codex',
      worktreeId: 'worktree-1',
      providerSession: {
        key: 'session_id',
        id: 'machine-session-1',
        transport: 'machine'
      }
    })
    const ensureReady = vi.fn(async () => participant)
    const publish = vi.fn(async () => undefined)
    const db = new RoomDatabase(':memory:')
    const surface = new RoomParticipantSurface(
      db,
      { ensureReady },
      undefined,
      undefined,
      undefined,
      publish
    )

    try {
      await surface.reveal(participant.id, 'chat')
    } finally {
      db.close()
    }

    expect(ensureReady).toHaveBeenCalledWith(participant.id)
    expect(publish).toHaveBeenCalledWith({
      workspaceId: 'worktree-1',
      sessionId: 'machine-session-1',
      agent: 'codex',
      activate: true
    })
  })
})
