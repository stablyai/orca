import type { RoomEvent, RoomHarnessAgent, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter, RoomHarnessBinding } from './harness-adapter'
import {
  hideRoomParticipantRendererStatus,
  roomParticipantHarnessBinding
} from './participant-harness-binding'

export const ROOM_AGENT_IDLE_SLEEP_MS = 30 * 60 * 1000

export async function hibernateIdleRoomParticipants(args: {
  db: RoomDatabase
  adapters: Record<RoomHarnessAgent, RoomHarnessAdapter>
  restoring: ReadonlyMap<string, Promise<RoomParticipant>>
  emit: (roomId: string, event: RoomEvent) => void
  hideRendererStatus?: (paneKey: string) => void
  now: number
}): Promise<void> {
  for (const participant of args.db.participants.listIdleAgents(
    args.now - ROOM_AGENT_IDLE_SLEEP_MS
  )) {
    const adapter = participant.agent ? args.adapters[participant.agent] : null
    const binding = roomParticipantHarnessBinding(participant)
    if (!adapter || !binding || args.restoring.has(participant.id)) {
      continue
    }
    await hibernateParticipant(args, adapter, participant, binding).catch(() => {})
  }
}

async function hibernateParticipant(
  args: Parameters<typeof hibernateIdleRoomParticipants>[0],
  adapter: RoomHarnessAdapter,
  participant: RoomParticipant,
  binding: RoomHarnessBinding
): Promise<void> {
  let current = binding
  let status: Awaited<ReturnType<RoomHarnessAdapter['status']>>
  try {
    status = await adapter.status(binding)
  } catch {
    const located = await adapter.locate(binding)
    if (!located) {
      markRoomParticipantSleeping(args.db, args.emit, participant)
      return
    }
    current = located
    participant = args.db.participants.update(participant.id, {
      terminalHandle: located.terminalHandle,
      paneKey: located.paneKey,
      ...(located.providerSession ? { providerSession: located.providerSession } : {})
    })
    hideRoomParticipantRendererStatus(participant, args.hideRendererStatus)
    status = await adapter.status(located)
  }
  if (status.isRunningAgent) {
    if (status.status === null) {
      const lastWrite = await adapter.lastTranscriptActivityAt(current)
      if (lastWrite === null || lastWrite > args.now - ROOM_AGENT_IDLE_SLEEP_MS) {
        return
      }
    } else if (status.status !== 'idle') {
      return
    }
    await adapter.stop(current)
  }
  markRoomParticipantSleeping(args.db, args.emit, participant)
}

export function markRoomParticipantSleeping(
  db: RoomDatabase,
  emit: (roomId: string, event: RoomEvent) => void,
  participant: RoomParticipant
): RoomParticipant {
  const updated = db.participants.update(participant.id, {
    state: 'sleeping',
    terminalSurfaceVisible: false
  })
  emit(updated.roomId, { type: 'participant.updated', participant: updated })
  return updated
}
