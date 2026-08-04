import {
  bucketFilesystemHostDuration,
  type FilesystemHostTelemetryEvent
} from './filesystem-host-telemetry'
import type {
  FilesystemHostDispatch,
  FilesystemHostLane
} from './filesystem-host-supervisor-scheduling'

export function recordFilesystemHostSupervisorTelemetry(input: {
  dispatch: FilesystemHostDispatch
  lane: FilesystemHostLane
  startedAt: number
  result: FilesystemHostTelemetryEvent['result']
  now: () => number
  abandonedChildren: number
  emit?: (event: FilesystemHostTelemetryEvent) => void
}): void {
  input.emit?.({
    operationId: input.dispatch.operationId,
    operation: input.dispatch.operation.kind,
    storageClass: input.dispatch.storageClass,
    result: input.result,
    duration: bucketFilesystemHostDuration(input.now() - input.startedAt),
    breaker: input.lane.breaker.snapshot().state,
    abandonedChildren: input.abandonedChildren
  })
}
