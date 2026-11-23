import { HOST_LOST_EXIT_CAUSE } from '../../../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import type {
  DaemonPtyRouterDataEvent,
  DaemonPtyRouterExitEvent
} from '../../protocol/daemon-pty-router-events'
import { STREAM_SEQUENCE_STAMP_PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import type { DataEvent } from '../../protocol/daemon-stream-events'

export function emitPtyListeners<T>(listeners: readonly T[], emit: (listener: T) => void): void {
  // Callbacks may change subscriptions; those changes apply to the next emission.
  listeners.slice().forEach(emit)
}

export function createPtyExitPayload(
  id: string,
  { code, incarnationId, cause, replacedByRestart, hostLost }: Omit<DaemonPtyRouterExitEvent, 'id'>
): DaemonPtyRouterExitEvent {
  return {
    id,
    code,
    ...(incarnationId ? { incarnationId } : {}),
    // Host loss is no stop request: without this a bare -1 reads as an unconfirmed stop.
    ...(cause || hostLost ? { cause: cause ?? HOST_LOST_EXIT_CAUSE } : {}),
    ...(replacedByRestart ? { replacedByRestart } : {}),
    ...(hostLost ? { hostLost } : {})
  }
}

export function createPtyDataPayload(
  { sessionId, payload }: DataEvent,
  protocolVersion: number
): DaemonPtyRouterDataEvent {
  const sequenceChars = payload.rawLength ?? payload.sequenceChars
  // Older daemons stamp only some frames, so main cannot anchor its count on them.
  const stamped =
    payload.seq !== undefined && protocolVersion >= STREAM_SEQUENCE_STAMP_PROTOCOL_VERSION
  return {
    id: sessionId,
    data: payload.data,
    ...(sequenceChars === undefined ? {} : { sequenceChars }),
    ...(payload.transformed ? { transformed: true } : {}),
    ...(stamped ? { seq: payload.seq } : {})
  }
}
