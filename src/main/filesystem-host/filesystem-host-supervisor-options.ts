import type { FilesystemHostCapacity } from './filesystem-host-capacity'
import type { FilesystemHostProcessOptions } from './filesystem-host-process'
import type { FilesystemHostProcessHandle } from './filesystem-host-supervisor-scheduling'
import type { FilesystemHostTelemetryEvent } from './filesystem-host-telemetry'

export type FilesystemHostProcessFactory = (
  options: FilesystemHostProcessOptions
) => Promise<FilesystemHostProcessHandle>

export type FilesystemHostSupervisorOptions = {
  entryPath: string
  maximumChildren?: number
  capacity?: FilesystemHostCapacity
  maximumPendingPerLane?: number
  breakerRecoveryDelayMs?: number
  now?: () => number
  startProcess?: FilesystemHostProcessFactory
  onTelemetry?: (event: FilesystemHostTelemetryEvent) => void
}
