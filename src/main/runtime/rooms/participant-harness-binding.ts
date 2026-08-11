import type { RuntimeCreateAgentSessionResult } from '../../../shared/agent-session-host-authority'
import type { RoomParticipant, RoomProviderSession } from '../../../shared/rooms'
import type { RoomHarnessBinding } from './harness-adapter-types'

export function roomParticipantHarnessBinding(
  participant: RoomParticipant
): RoomHarnessBinding | null {
  return participant.terminalHandle && participant.paneKey && participant.worktreeId
    ? {
        worktreeId: participant.worktreeId,
        terminalHandle: participant.terminalHandle,
        paneKey: participant.paneKey,
        providerSession: participant.providerSession
      }
    : null
}

export function hideRoomParticipantRendererStatus(
  participant: RoomParticipant,
  hide: ((paneKey: string) => void) | undefined
): void {
  if (!participant.terminalSurfaceVisible && participant.paneKey) {
    hide?.(participant.paneKey)
  }
}

export function roomHarnessBindingFromTerminal(
  worktreeId: string,
  terminal: RuntimeCreateAgentSessionResult['terminal'],
  providerSession: RoomProviderSession | null,
  disposition: RoomHarnessBinding['disposition']
): RoomHarnessBinding {
  if (!terminal.paneKey) {
    throw new Error('room_agent_pane_unavailable')
  }
  return {
    worktreeId,
    terminalHandle: terminal.handle,
    paneKey: terminal.paneKey,
    providerSession,
    disposition
  }
}
