import type SyncDatabase from '../../sqlite/sync-database'
import type { RoomParticipant } from '../../../shared/rooms'
import type { RoomHarnessBinding } from './harness-adapter-types'
import { roomParticipantHarnessBinding } from './participant-harness-binding'
import { participantFromRow, type RoomRow } from './rows'

type RoomDeliveryBindingEvidence =
  | {
      transport: 'machine'
      worktreeId: string
      providerSessionKey: string
      providerSessionId: string
    }
  | {
      transport: 'terminal'
      worktreeId: string
      terminalHandle: string
      paneKey: string
      providerSessionKey: string | null
      providerSessionId: string | null
    }

export type RoomReadyTarget = {
  participantId: string
  state: RoomParticipant['state']
  processIncarnation: string | null
  binding: RoomDeliveryBindingEvidence | null
}

export function roomDeliveryReadiness(
  participant: RoomParticipant,
  binding: RoomHarnessBinding | null
): RoomReadyTarget {
  return {
    participantId: participant.id,
    state: participant.state,
    processIncarnation: participant.processIncarnation,
    binding: !binding
      ? null
      : binding.transport === 'machine'
        ? {
            transport: 'machine',
            worktreeId: binding.worktreeId,
            providerSessionKey: binding.providerSession.key,
            providerSessionId: binding.providerSession.id
          }
        : {
            transport: 'terminal',
            worktreeId: binding.worktreeId,
            terminalHandle: binding.terminalHandle,
            paneKey: binding.paneKey,
            providerSessionKey: binding.providerSession?.key ?? null,
            providerSessionId: binding.providerSession?.id ?? null
          }
  }
}

export function activeRoomReadinessMatches(
  db: SyncDatabase.Database,
  roomId: string,
  expected: readonly RoomReadyTarget[]
): boolean {
  const current = (
    db
      .prepare(
        `SELECT * FROM room_participants WHERE room_id = ? AND actor_kind = 'agent'
         AND participation = 'active' ORDER BY id`
      )
      .all(roomId) as RoomRow[]
  ).map(participantFromRow)
  if (
    current.length !== expected.length ||
    new Set(expected.map(({ participantId }) => participantId)).size !== current.length
  ) {
    return false
  }
  return expected.every((evidence) => {
    const participant = current.find((candidate) => candidate.id === evidence.participantId)
    const binding = participant ? roomParticipantHarnessBinding(participant) : null
    const currentEvidence = participant ? roomDeliveryReadiness(participant, binding) : null
    return Boolean(
      currentEvidence &&
      currentEvidence.state === evidence.state &&
      currentEvidence.processIncarnation === evidence.processIncarnation &&
      sameBinding(currentEvidence.binding, evidence.binding)
    )
  })
}

function sameBinding(
  current: RoomDeliveryBindingEvidence | null,
  expected: RoomDeliveryBindingEvidence | null
): boolean {
  if (!current || !expected) {
    return current === expected
  }
  if (current.transport !== expected.transport || current.worktreeId !== expected.worktreeId) {
    return false
  }
  if (current.transport === 'machine' && expected.transport === 'machine') {
    return (
      current.providerSessionKey === expected.providerSessionKey &&
      current.providerSessionId === expected.providerSessionId
    )
  }
  return (
    current.transport === 'terminal' &&
    expected.transport === 'terminal' &&
    current.terminalHandle === expected.terminalHandle &&
    current.paneKey === expected.paneKey &&
    current.providerSessionKey === expected.providerSessionKey &&
    current.providerSessionId === expected.providerSessionId
  )
}
