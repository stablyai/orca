import { createProfileStateWriterDeadline } from './profile-state-writer-deadline'
import {
  recordProfileStateWriterGrace,
  recordProfileStateWriterTimeout
} from './profile-state-writer-diagnostics'
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
  clearDeadline: () => void
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

/** Each request owns its deadline; timeouts and grace leave a durable breadcrumb. */
export function createProfileStateWriterRequest(
  id: number,
  command: PendingProfileStateWriterRequest['command'],
  timeoutMs: number,
  handlers: { onTimeout: () => void; acknowledgedRevision: () => number; now?: () => number }
): PendingProfileStateWriterRequest {
  const describe = () => ({
    command,
    requestId: id,
    acknowledgedRevision: handlers.acknowledgedRevision()
  })
  const deadline = createProfileStateWriterDeadline(
    timeoutMs,
    (expiry) => {
      recordProfileStateWriterTimeout(describe(), expiry)
      handlers.onTimeout()
    },
    { now: handlers.now, onGrace: (expiry) => recordProfileStateWriterGrace(describe(), expiry) }
  )
  return {
    id,
    command,
    ...Promise.withResolvers<SuccessfulProfileStateWriterResponse>(),
    clearDeadline: deadline.clear
  }
}
