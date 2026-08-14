import type { RuntimeCreateAgentSessionResult } from '../../../shared/agent-session-host-authority'
import type { RoomParticipant, RoomProviderSession } from '../../../shared/rooms'
import type { RoomHarnessBinding, RoomTerminalHarnessBinding } from './harness-adapter-types'

export function roomParticipantHarnessBinding(
  participant: RoomParticipant
): RoomHarnessBinding | null {
  if (
    participant.worktreeId &&
    participant.providerSession?.transport === 'machine' &&
    !participant.terminalHandle
  ) {
    return {
      transport: 'machine',
      worktreeId: participant.worktreeId,
      conversationId: participant.providerSession.id,
      providerSession: participant.providerSession
    }
  }
  return participant.terminalHandle && participant.paneKey && participant.worktreeId
    ? {
        transport: 'terminal',
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

export function roomParticipantFieldsFromBinding(
  binding: RoomHarnessBinding
): Pick<RoomParticipant, 'worktreeId' | 'paneKey' | 'terminalHandle' | 'providerSession'> {
  return {
    worktreeId: binding.worktreeId,
    paneKey: binding.transport !== 'machine' ? binding.paneKey : null,
    terminalHandle: binding.transport !== 'machine' ? binding.terminalHandle : null,
    providerSession: binding.providerSession
  }
}

export function roomHarnessBindingFromTerminal(
  worktreeId: string,
  terminal: RuntimeCreateAgentSessionResult['terminal'],
  providerSession: RoomProviderSession | null,
  disposition: RoomHarnessBinding['disposition']
): RoomTerminalHarnessBinding {
  if (!terminal.paneKey) {
    throw new Error('room_agent_pane_unavailable')
  }
  return {
    transport: 'terminal',
    worktreeId,
    terminalHandle: terminal.handle,
    paneKey: terminal.paneKey,
    providerSession,
    disposition
  }
}
