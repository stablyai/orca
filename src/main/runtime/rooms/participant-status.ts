import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener'
import type { ClaudeStatusLineRateLimits } from '../../../shared/claude-statusline-rate-limits'
import type { RoomEvent, RoomHarnessAgent, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter } from './harness-adapter'
import { roomParticipantHarnessBinding } from './participant-harness-binding'
import type { RoomTranscriptBridge } from './transcript-bridge'

export function ingestRoomParticipantStatus(
  db: RoomDatabase,
  adapters: Record<RoomHarnessAgent, RoomHarnessAdapter>,
  transcriptBridge: RoomTranscriptBridge,
  emit: (roomId: string, event: RoomEvent) => void,
  event: AgentHookEventPayload & { receivedAt: number }
): void {
  const current = db.participants.findByPaneKey(event.paneKey)
  if (!current || (event.payload.agentType && event.payload.agentType !== current.agent)) {
    return
  }
  const lifecycle = current.agent ? adapters[current.agent].statusEvent(event) : null
  const compaction =
    event.hookEventName === 'PreCompact'
      ? 'running'
      : event.hookEventName === 'PostCompact'
        ? 'completed'
        : current.context.compaction
  const state =
    event.payload.state === 'working' || event.payload.state === 'blocked' ? 'busy' : 'online'
  const participant = db.participants.update(current.id, {
    state,
    lastSeenAt: event.receivedAt,
    providerSession: event.providerSession ?? current.providerSession,
    context: {
      ...current.context,
      model: event.payload.model ?? current.context.model,
      compaction,
      compactionUpdatedAt:
        compaction === current.context.compaction
          ? current.context.compactionUpdatedAt
          : event.receivedAt
    }
  })
  emit(participant.roomId, { type: 'participant.updated', participant })
  transcriptBridge.ingestStatus(participant.id, lifecycle)
  void transcriptBridge.ensure(participant)
  if (event.hookEventName === 'PostCompact') {
    db.deliveryConfiguration.requireFull(participant.id)
    void transcriptBridge.refreshContext(participant).catch(() => {})
  }
}

export function ingestRoomParticipantClaudeStatusLine(
  db: RoomDatabase,
  emit: (roomId: string, event: RoomEvent) => void,
  event: ClaudeStatusLineRateLimits
): void {
  if (!event.paneKey || (!event.context && !event.model && !event.effort)) {
    return
  }
  const current = db.participants.findByPaneKey(event.paneKey)
  if (!current || current.agent !== (event.agent ?? 'claude')) {
    return
  }
  const compacted =
    current.context.compaction === 'running' &&
    current.context.usedTokens !== null &&
    event.context?.usedTokens !== null &&
    event.context?.usedTokens !== undefined &&
    event.context.usedTokens < current.context.usedTokens
  const participant = db.participants.update(current.id, {
    context: {
      ...current.context,
      ...event.context,
      ...(event.model ? { model: event.model } : {}),
      ...(event.effort ? { effort: event.effort } : {}),
      ...(event.context && { estimated: event.context.estimated }),
      source: 'statusline',
      observedAt: Date.now(),
      compaction: compacted ? 'completed' : current.context.compaction,
      compactionUpdatedAt: compacted ? Date.now() : current.context.compactionUpdatedAt,
      error: undefined
    }
  })
  if (compacted) {
    db.deliveryConfiguration.requireFull(participant.id)
  }
  emit(participant.roomId, { type: 'participant.updated', participant })
}

export function updateRoomParticipantStatus(
  db: RoomDatabase,
  adapters: Record<RoomHarnessAgent, RoomHarnessAdapter>,
  emit: (roomId: string, event: RoomEvent) => void,
  participant: RoomParticipant,
  isRunningAgent: boolean,
  status: Awaited<ReturnType<RoomHarnessAdapter['status']>>['status']
): RoomParticipant {
  const adapter = participant.agent ? adapters[participant.agent] : null
  const binding = roomParticipantHarnessBinding(participant)
  const incarnation = isRunningAgent && adapter && binding ? adapter.incarnation(binding) : null
  const nextState = isRunningAgent ? (status === 'working' ? 'busy' : 'online') : 'offline'
  const incarnationChanged = incarnation !== null && incarnation !== participant.processIncarnation
  if (nextState === participant.state && !incarnationChanged) {
    return participant
  }
  const updated = db.participants.update(participant.id, {
    state: nextState,
    ...(incarnationChanged ? { processIncarnation: incarnation } : {})
  })
  emit(updated.roomId, { type: 'participant.updated', participant: updated })
  return updated
}
