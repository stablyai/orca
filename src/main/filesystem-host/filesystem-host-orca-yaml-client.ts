import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { FilesystemHostBackgroundAdmission } from './filesystem-host-background-queue'
import type { FilesystemHostFailureDomainHydrator } from './filesystem-host-failure-domain-hydrator'
import type { FilesystemHostSupervisor } from './filesystem-host-supervisor'
import type { routeFilesystemHostPath } from './filesystem-host-path-route'
import { remainingFilesystemHostBudget } from './filesystem-host-deadline'
import {
  FilesystemHostReadError,
  filesystemHostReadFailureReason,
  requireFilesystemHostResult
} from './filesystem-host-read-result'

export async function readFilesystemHostOrcaYaml(
  path: string,
  options: {
    deadlineMs: number
    failureDomains: FilesystemHostFailureDomainHydrator
    queue: FilesystemHostBackgroundAdmission
    dispatch: FilesystemHostSupervisor['dispatch']
    route: ReturnType<typeof routeFilesystemHostPath>
  }
): Promise<string> {
  const expiresAt = Date.now() + options.deadlineMs
  let releaseFailureDomain: (() => void) | undefined
  try {
    releaseFailureDomain = await options.failureDomains
      .acquire(dirname(path), expiresAt)
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          ['deadline', 'WSL_DISTRO_STOPPED', 'WSL_DISTRO_UNVERIFIABLE'].includes(String(error.code))
        ) {
          throw error
        }
        return undefined
      })
    remainingFilesystemHostBudget(expiresAt)
    const result = await options.queue.run(
      (deadlineMs) =>
        options.dispatch({
          operationId: randomUUID(),
          operation: { kind: 'read-orca-yaml', path, maxBytes: 1024 * 1024 },
          ...options.route,
          admission: 'background',
          deadlineMs
        }),
      null,
      expiresAt
    )
    return requireFilesystemHostResult(result, 'read-orca-yaml').contents
  } catch (error) {
    throw new FilesystemHostReadError(filesystemHostReadFailureReason(error))
  } finally {
    releaseFailureDomain?.()
  }
}
