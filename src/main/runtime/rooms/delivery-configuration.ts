import type SyncDatabase from '../../sqlite/sync-database'
import type { Room, RoomParticipant, RoomRole } from '../../../shared/rooms'

type DeliveredConfigurationRow = {
  provider_session_key: string | null
  provider_session_id: string | null
  description: string
  role_revision: string
  force_full: number
}

export type RoomDeliveryConfiguration = {
  description?: string
  role?: RoomRole | null
  cleared?: ('description' | 'role')[]
}

export type RoomDeliveryConfigurationSnapshot = {
  providerSessionKey: string | null
  providerSessionId: string | null
  description: string
  roleRevision: string
}

export type PendingRoomDeliveryConfirmation = {
  participantId: string
  configuration: RoomDeliveryConfigurationSnapshot
}

export function ensureRoomDeliveryConfigurationSchema(db: SyncDatabase.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_delivery_configuration (
      participant_id TEXT PRIMARY KEY REFERENCES room_participants(id) ON DELETE CASCADE,
      provider_session_key TEXT,
      provider_session_id TEXT,
      description TEXT NOT NULL DEFAULT '',
      role_revision TEXT NOT NULL DEFAULT '',
      force_full INTEGER NOT NULL DEFAULT 1 CHECK(force_full IN (0, 1)),
      updated_at INTEGER NOT NULL
    );
  `)
}

export class RoomDeliveryConfigurationStore {
  constructor(private readonly db: SyncDatabase.Database) {}

  pending(input: { participant: RoomParticipant; room: Room; role: RoomRole | null }): {
    configuration: RoomDeliveryConfiguration
    snapshot: RoomDeliveryConfigurationSnapshot
  } {
    const snapshot = this.snapshot(input)
    const delivered = this.db
      .prepare('SELECT * FROM room_delivery_configuration WHERE participant_id = ?')
      .get(input.participant.id) as DeliveredConfigurationRow | undefined
    const full =
      !delivered ||
      delivered.force_full === 1 ||
      delivered.provider_session_key !== snapshot.providerSessionKey ||
      delivered.provider_session_id !== snapshot.providerSessionId
    const cleared: RoomDeliveryConfiguration['cleared'] = []
    if (!full && delivered.description && !snapshot.description) {
      cleared.push('description')
    }
    if (!full && delivered.role_revision && !snapshot.roleRevision) {
      cleared.push('role')
    }

    return {
      configuration: {
        ...((full || delivered.description !== snapshot.description) && input.room.description
          ? { description: input.room.description }
          : {}),
        ...((full || delivered.role_revision !== snapshot.roleRevision) && input.role
          ? { role: input.role }
          : {}),
        ...(cleared.length ? { cleared } : {})
      },
      snapshot
    }
  }

  commit(participantId: string, snapshot: RoomDeliveryConfigurationSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO room_delivery_configuration (
          participant_id, provider_session_key, provider_session_id, description,
          role_revision, force_full, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(participant_id) DO UPDATE SET
          provider_session_key = excluded.provider_session_key,
          provider_session_id = excluded.provider_session_id,
          description = excluded.description,
          role_revision = excluded.role_revision,
          force_full = 0,
          updated_at = excluded.updated_at`
      )
      .run(
        participantId,
        snapshot.providerSessionKey,
        snapshot.providerSessionId,
        snapshot.description,
        snapshot.roleRevision,
        Date.now()
      )
  }

  requireFull(participantId: string): void {
    this.db
      .prepare(
        'UPDATE room_delivery_configuration SET force_full = 1, updated_at = ? WHERE participant_id = ?'
      )
      .run(Date.now(), participantId)
  }

  private snapshot(input: {
    participant: RoomParticipant
    room: Room
    role: RoomRole | null
  }): RoomDeliveryConfigurationSnapshot {
    return {
      providerSessionKey: input.participant.providerSession?.key ?? null,
      providerSessionId: input.participant.providerSession?.id ?? null,
      description: input.room.description,
      roleRevision: input.role
        ? JSON.stringify([input.role.id, input.role.name, input.role.prompt])
        : ''
    }
  }
}
