import type { JournalResultPacket } from '../../native-chat/agent-session-journal/journal-unit-transfer'
import { startProfileStateWriterSlowWarning } from './profile-state-writer-slow-warning'
import type {
  ProfileStateWriterCommand,
  ProfileStateWriterResponse
} from './profile-state-writer-protocol'

export type SuccessfulProfileStateWriterResponse = Extract<ProfileStateWriterResponse, { ok: true }>
export type PendingProfileStateWriterRequest = {
  id: number
  journalPackets?: (packets: JournalResultPacket[]) => void
  command: ProfileStateWriterCommand['command'] | 'initialize'
  promise: Promise<SuccessfulProfileStateWriterResponse>
  resolve: (response: SuccessfulProfileStateWriterResponse) => void
  reject: (error: Error) => void
  clearSlowWarning: () => void
}

export function isExpectedProfileStateWriterSuccess(
  command: PendingProfileStateWriterRequest['command'],
  response: SuccessfulProfileStateWriterResponse,
  previousRevision: number
): boolean {
  const mayWrite = command.startsWith('write-')
  if (
    (command === 'write-surface') !== (response.surfaceResult !== undefined) ||
    (command === 'write-surfaces' || command === 'write-surface-joint') !==
      (response.surfaceResults !== undefined)
  ) {
    return false
  }
  if (
    response.revision < previousRevision ||
    response.revision > previousRevision + (mayWrite ? 1 : 0)
  ) {
    return false
  }
  if (
    response.exportedRevision !== undefined &&
    response.exportedRevision !== null &&
    response.exportedRevision !== response.revision
  ) {
    return false
  }
  if (command === 'export-json') {
    return response.exportedRevision !== undefined && response.exportedRevision !== null
  }
  if (command === 'export-latest') {
    return (
      response.exportedRevision !== undefined &&
      (response.exportedRevision !== null || response.revision === 0)
    )
  }
  return response.exportedRevision === undefined
}

/** Slowness warns; only a matching reply or real fault settles the request. */
export function createProfileStateWriterRequest(
  id: number,
  command: PendingProfileStateWriterRequest['command'],
  slowWarningMs: number,
  diagnostics: { acknowledgedRevision: number; now?: () => number; onSlow?: () => void }
): PendingProfileStateWriterRequest {
  const clearSlowWarning = startProfileStateWriterSlowWarning({
    warningMs: slowWarningMs,
    phase: 'awaiting-reply',
    now: diagnostics.now,
    onSlow: diagnostics.onSlow,
    request: {
      command,
      requestId: id,
      acknowledgedRevision: diagnostics.acknowledgedRevision
    }
  })
  return {
    id,
    command,
    ...Promise.withResolvers<SuccessfulProfileStateWriterResponse>(),
    clearSlowWarning
  }
}

export type ProfileStateWriterConnectionOptions = {
  workerPath?: string
  /** One diagnostic warning; delay alone never fails the request. */
  slowWarningMs?: number
  onFailure?: (error: Error) => void
  onSaveDelayChanged?: (delayed: boolean) => void
  reportInitializationFailure?: boolean
  /** Monotonic clock; replace in tests to model stalled main loops. */
  clock?: () => number
}
