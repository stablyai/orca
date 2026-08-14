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
            sameProviderSession(participant.providerSession, input.providerSession))
      ) ?? null
  )
}

function sameProviderSession(
  left: RoomProviderSession | null,
  right: RoomProviderSession
): boolean {
  return Boolean(
    left &&
    ((left.key === right.key && left.id === right.id) ||
      (left.sourceSessionId &&
        (left.sourceSessionId === right.sourceSessionId || left.sourceSessionId === right.id)) ||
      (right.sourceSessionId && right.sourceSessionId === left.id))
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
