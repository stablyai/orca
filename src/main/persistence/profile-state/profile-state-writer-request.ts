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
  timer: ReturnType<typeof setTimeout>
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
  if (command === 'export-compatibility' || command === 'export-latest') {
    return (
      response.exportedRevision !== undefined &&
      (response.exportedRevision !== null || response.revision === 0)
    )
  }
  return response.exportedRevision === undefined
}

export function createProfileStateWriterRequest(
  id: number,
  command: PendingProfileStateWriterRequest['command'],
  timeoutMs: number,
  onTimeout: () => void
): PendingProfileStateWriterRequest {
  return {
    id,
    command,
    ...Promise.withResolvers<SuccessfulProfileStateWriterResponse>(),
    timer: setTimeout(onTimeout, timeoutMs)
  }
}
