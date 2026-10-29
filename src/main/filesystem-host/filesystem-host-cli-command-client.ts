import { randomUUID } from 'node:crypto'
import type {
  FilesystemCliCommandName,
  FilesystemHostResult
} from '../../shared/filesystem-host-protocol'
import type { FilesystemExecutionHost } from './filesystem-host-failure-domain'
import type { FilesystemHostBackgroundAdmission } from './filesystem-host-background-queue'
import type { FilesystemHostDispatch } from './filesystem-host-supervisor-scheduling'
import type { FilesystemStorageClass } from './filesystem-host-telemetry'

export async function resolveFilesystemHostCliCommand(options: {
  commandName: FilesystemCliCommandName
  homePath: string
  pathEnvironment: string
  route: { executionHost: FilesystemExecutionHost; storageClass: FilesystemStorageClass }
  deadlineMs: number
  queue: FilesystemHostBackgroundAdmission
  dispatch(input: FilesystemHostDispatch): Promise<FilesystemHostResult>
}): Promise<string> {
  const result = await options.queue.run(
    (deadlineMs) =>
      options.dispatch({
        operationId: randomUUID(),
        operation: {
          kind: 'resolve-cli-command',
          path: options.homePath,
          commandName: options.commandName,
          pathEnvironment: options.pathEnvironment
        },
        ...options.route,
        admission: 'background',
        deadlineMs
      }),
    null,
    Date.now() + options.deadlineMs
  )
  if (result.kind !== 'resolve-cli-command') {
    throw new Error('Filesystem host returned the wrong CLI command result')
  }
  return result.command
}
