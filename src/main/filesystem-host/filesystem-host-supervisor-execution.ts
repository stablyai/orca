import type { FilesystemHostResult } from '../../shared/filesystem-host-protocol'
import { FilesystemHostProcessError } from './filesystem-host-process'
import type {
  FilesystemHostDispatch,
  FilesystemHostLane,
  FilesystemHostProcessHandle,
  FilesystemHostQueuedDispatch
} from './filesystem-host-supervisor-scheduling'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'
import type { FilesystemHostTelemetryEvent } from './filesystem-host-telemetry'

type ExecutionContext = {
  now: () => number
  launch: (
    lane: FilesystemHostLane,
    admission: FilesystemHostDispatch['admission']
  ) => Promise<FilesystemHostProcessHandle>
  abandon: (laneKey: string, lane: FilesystemHostLane, process: FilesystemHostProcessHandle) => void
  recordTelemetry: (
    input: FilesystemHostDispatch,
    lane: FilesystemHostLane,
    startedAt: number,
    result: FilesystemHostTelemetryEvent['result']
  ) => void
}

export async function executeFilesystemHostDispatch(
  context: ExecutionContext,
  lane: FilesystemHostLane,
  job: FilesystemHostQueuedDispatch
): Promise<FilesystemHostResult> {
  const input = job.input
  const startedAt = context.now()
  const admission = lane.breaker.admit(startedAt)
  if (!admission.allowed) {
    context.recordTelemetry(input, lane, startedAt, 'rejected')
    throw new FilesystemHostSupervisorError(
      'breaker-open',
      'Filesystem failure domain is unavailable'
    )
  }
  let process = lane.process
  try {
    process ??= await context.launch(lane, input.admission)
    const result = await process.invoke(input.operation, input.deadlineMs, input.operationId)
    lane.breaker.recordSuccess(admission.probe)
    context.recordTelemetry(input, lane, startedAt, 'success')
    return result
  } catch (error) {
    if (error instanceof FilesystemHostSupervisorError) {
      if (admission.probe) {
        if (error.code === 'capacity') {
          lane.breaker.deferProbe()
        } else {
          lane.breaker.recordFailure(context.now())
        }
      }
      context.recordTelemetry(input, lane, startedAt, 'rejected')
      throw error
    }
    if (error instanceof FilesystemHostProcessError && error.code === 'operation') {
      lane.breaker.recordSuccess(admission.probe)
      context.recordTelemetry(input, lane, startedAt, 'domain-error')
      throw new FilesystemHostSupervisorError('operation', error.message, error.operationCode)
    }
    lane.breaker.recordFailure(context.now())
    if (process && lane.process === process) {
      context.abandon(lane.key, lane, process)
    }
    const deadline = error instanceof FilesystemHostProcessError && error.code === 'deadline'
    context.recordTelemetry(input, lane, startedAt, deadline ? 'deadline' : 'unavailable')
    throw new FilesystemHostSupervisorError(
      deadline ? 'deadline' : 'unavailable',
      deadline ? 'Filesystem operation timed out' : 'Filesystem host is unavailable'
    )
  }
}
