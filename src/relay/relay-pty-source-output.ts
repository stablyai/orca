import { randomUUID } from 'node:crypto'
import type { PtySourceDeliveryIdentity } from '../shared/pty-source-credit-contract'
import type { LegacyProjectionRole, RelayDispatcher } from './dispatcher'
import type { RelayPtySourceDeliveryRecord } from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

export type RelayPtySourceOutput = {
  data: string
  rawLength?: number
  transformed?: boolean
  seq?: number
  sourceAccepted?: boolean
  sourceSpanId?: string
}

// Why: an evicted tombstone probes null, so an unknown delivery counts as closed.
export function ptySourceDeliveryClosed(
  session: SshPtyConsumerSessionAdapter,
  identity: PtySourceDeliveryIdentity
): boolean {
  const state = session.sourceDeliverySnapshotIfKnown(identity)?.state
  return !state || state === 'closed' || state === 'closing'
}

export function appendPtySourceOutput(
  session: SshPtyConsumerSessionAdapter,
  record: RelayPtySourceDeliveryRecord,
  output: RelayPtySourceOutput
): boolean {
  const rawLength = output.rawLength ?? output.data.length
  output.sourceSpanId ??= randomUUID()
  try {
    session.appendSource(record.identity, {
      spanId: output.sourceSpanId,
      data: output.data,
      displayStart: record.displayEnd,
      displayEnd: record.displayEnd + output.data.length,
      splittable: output.transformed !== true,
      transform: {
        transformed: output.transformed === true,
        rawLengthSu: rawLength,
        scalarSafe: output.transformed !== true
      }
    })
  } catch {
    return false
  }
  output.sourceAccepted = true
  record.displayEnd += output.data.length
  return true
}

/**
 * Only a session owner is served solely by the legacy projection, so only it may back-pressure the native
 * PTY. Every other target — agent hooks, `orca` CLI processes, a second window, a client still completing
 * pty.openClient — is a bystander mirror that would otherwise wedge the terminal for everyone.
 */
export function legacyProjectionRole(
  session: SshPtyConsumerSessionAdapter,
  clientId: number
): LegacyProjectionRole {
  const mode = session.deliveryMode(clientId)
  if (mode === 'source-owner') {
    return 'skip'
  }
  return mode === 'legacy-owner' ? 'owner' : 'mirror'
}

export function projectPtySourceOutputToLegacy(
  dispatcher: RelayDispatcher,
  session: SshPtyConsumerSessionAdapter,
  id: string,
  output: RelayPtySourceOutput,
  interactive: boolean
): boolean {
  return dispatcher.projectPtyDataToLegacyClients(
    (clientId) => legacyProjectionRole(session, clientId),
    {
      id,
      data: output.data,
      ...(output.seq === undefined ? {} : { seq: output.seq }),
      ...(output.rawLength === undefined ? {} : { rawLength: output.rawLength }),
      ...(output.transformed ? { transformed: true } : {})
    },
    { interactive }
  )
}
