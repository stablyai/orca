import type SyncDatabase from '../../sqlite/sync-database'
import type {
  RoomExistingAgentCandidate,
  RoomHarnessAgent,
  RoomParticipant,
  RoomProviderSession
} from '../../../shared/rooms'
import { participantFromRow, type RoomRow } from './rows'

export type RoomAgentOwnershipIdentity = {
  worktreeId?: string | null
  agent?: RoomHarnessAgent
  paneKey?: string | null
  terminalHandle?: string | null
  providerSession?: RoomProviderSession | null
}

export function findRoomAgentOwner(
  db: SyncDatabase.Database,
  input: RoomAgentOwnershipIdentity
): RoomParticipant | null {
  const rows = db
    .prepare(
      `SELECT * FROM room_participants WHERE actor_kind = 'agent' AND (
        pane_key = ? OR terminal_handle = ? OR
        (worktree_id = ? AND provider_session_json IS NOT NULL)
      )`
    )
    .all(input.paneKey ?? null, input.terminalHandle ?? null, input.worktreeId ?? null) as RoomRow[]
  const family = input.agent === 'openclaude' ? 'claude' : input.agent
  return (
    rows
      .map(participantFromRow)
      .find(
        (participant) =>
          (input.paneKey && participant.paneKey === input.paneKey) ||
          (input.terminalHandle && participant.terminalHandle === input.terminalHandle) ||
          (family &&
            input.providerSession &&
            (participant.agent === 'openclaude' ? 'claude' : participant.agent) === family &&
            participant.providerSession?.key === input.providerSession.key &&
            participant.providerSession.id === input.providerSession.id)
      ) ?? null
  )
}

export function withoutRoomAgentOwners(
  participants: { findOwner(input: RoomAgentOwnershipIdentity): RoomParticipant | null },
  candidates: RoomExistingAgentCandidate[],
  worktreeId: string,
  agent: RoomHarnessAgent
): RoomExistingAgentCandidate[] {
  return candidates.filter(
    (candidate) => !participants.findOwner({ ...candidate, worktreeId, agent })
  )
}
