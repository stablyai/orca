import { startProfileStateWriterSlowWarning } from './profile-state-writer-slow-warning'
import type {
  ProfileStateWriterCommand,
  ProfileStateWriterResponse
} from './profile-state-writer-protocol'

export type SuccessfulProfileStateWriterResponse = Extract<ProfileStateWriterResponse, { ok: true }>
export type PendingProfileStateWriterRequest = {
  id: number
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

/** A request stays pending until its matching reply or a real fault; slowness only warns. */
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
