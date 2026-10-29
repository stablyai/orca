import type { FilesystemHostOperation } from '../../shared/filesystem-host-protocol'
import type { FilesystemHostBreakerState } from './filesystem-host-breaker'

export type FilesystemStorageClass = 'home' | 'user-data' | 'workspace' | 'wsl' | 'unc'

export type FilesystemHostTelemetryEvent = {
  operationId: string
  operation: FilesystemHostOperation['kind']
  storageClass: FilesystemStorageClass
  result: 'success' | 'domain-error' | 'deadline' | 'outcome-unknown' | 'unavailable' | 'rejected'
  duration: '<100ms' | '<1s' | '<10s' | '>=10s'
  breaker: FilesystemHostBreakerState
  abandonedChildren: number
}

export function bucketFilesystemHostDuration(
  duration: number
): FilesystemHostTelemetryEvent['duration'] {
  return duration < 100 ? '<100ms' : duration < 1_000 ? '<1s' : duration < 10_000 ? '<10s' : '>=10s'
}
