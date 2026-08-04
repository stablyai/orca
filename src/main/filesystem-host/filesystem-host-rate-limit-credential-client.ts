import { randomUUID } from 'node:crypto'
import type {
  FilesystemHostResult,
  RateLimitCredentialFileKind
} from '../../shared/filesystem-host-protocol'
import type { FilesystemExecutionHost } from './filesystem-host-failure-domain'
import type { FilesystemHostBackgroundQueue } from './filesystem-host-background-queue'
import type { FilesystemHostDispatch } from './filesystem-host-supervisor-scheduling'
import type { FilesystemStorageClass } from './filesystem-host-telemetry'

export async function writeFilesystemHostRateLimitCredential(options: {
  path: string
  fileKind: RateLimitCredentialFileKind
  contents: string
  route: { executionHost: FilesystemExecutionHost; storageClass: FilesystemStorageClass }
  deadlineMs: number
  queue: FilesystemHostBackgroundQueue
  dispatch(input: FilesystemHostDispatch): Promise<FilesystemHostResult>
}): Promise<void> {
  const result = await options.queue.run(() =>
    options.dispatch({
      operationId: randomUUID(),
      operation: {
        kind: 'write-rate-limit-credential',
        path: options.path,
        fileKind: options.fileKind,
        contents: options.contents
      },
      ...options.route,
      admission: 'background',
      deadlineMs: options.deadlineMs
    })
  )
  if (result.kind !== 'write-rate-limit-credential') {
    throw new Error('Filesystem host returned the wrong credential-write result')
  }
}
