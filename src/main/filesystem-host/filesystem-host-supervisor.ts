import {
  filesystemHostOperationSchema,
  type FilesystemHostResult
} from '../../shared/filesystem-host-protocol'
import { FilesystemHostBreaker } from './filesystem-host-breaker'
import {
  FilesystemHostCapacity,
  processWideFilesystemHostCapacity,
  type FilesystemHostAdmissionClass
} from './filesystem-host-capacity'
import type { FilesystemExecutionHost } from './filesystem-host-failure-domain'
import { FilesystemHostFailureDomainCoordinator } from './filesystem-host-failure-domain-coordinator'
import { FilesystemHostProcess } from './filesystem-host-process'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'
import { executeFilesystemHostDispatch } from './filesystem-host-supervisor-execution'
import {
  snapshotFilesystemHostSupervisorHealth,
  type FilesystemHostSupervisorHealth
} from './filesystem-host-supervisor-health'
import type {
  FilesystemHostDispatch,
  FilesystemHostLane,
  FilesystemHostProcessHandle
} from './filesystem-host-supervisor-scheduling'
import { recordFilesystemHostSupervisorTelemetry } from './filesystem-host-supervisor-telemetry'
import { reclaimIdleFilesystemHostProcess } from './filesystem-host-idle-process-reclamation'
import { FilesystemHostProcessRetirement } from './filesystem-host-process-retirement'
import type {
  FilesystemHostProcessFactory,
  FilesystemHostSupervisorOptions
} from './filesystem-host-supervisor-options'

export type { FilesystemHostDispatch } from './filesystem-host-supervisor-scheduling'
export type { FilesystemHostSupervisorOptions } from './filesystem-host-supervisor-options'

export class FilesystemHostSupervisor {
  private readonly capacity: FilesystemHostCapacity
  private readonly lanes = new Map<string, FilesystemHostLane>()
  private readonly retirement = new FilesystemHostProcessRetirement()
  private readonly domains = new FilesystemHostFailureDomainCoordinator(this.lanes, this.retirement)
  private readonly launches = new Set<Promise<FilesystemHostProcessHandle>>()
  private readonly maximumPendingPerLane: number
  private readonly foregroundPendingReserve: number
  private readonly breakerRecoveryDelayMs: number
  private readonly now: () => number
  private readonly startProcess: FilesystemHostProcessFactory
  private disposed = false

  constructor(private readonly options: FilesystemHostSupervisorOptions) {
    this.capacity =
      options.capacity ??
      (options.maximumChildren !== undefined
        ? new FilesystemHostCapacity(options.maximumChildren)
        : processWideFilesystemHostCapacity)
    this.maximumPendingPerLane = options.maximumPendingPerLane ?? 64
    this.foregroundPendingReserve = Math.max(1, Math.floor(this.maximumPendingPerLane / 4))
    this.breakerRecoveryDelayMs = options.breakerRecoveryDelayMs ?? 30_000
    this.now = options.now ?? Date.now
    this.startProcess = options.startProcess ?? ((input) => FilesystemHostProcess.start(input))
  }

  publishFailureDomain(input: {
    executionHost: FilesystemExecutionHost
    prefix: string
    mountId: string
  }): void {
    this.domains.publish(input)
  }

  removeFailureDomain(input: { executionHost: FilesystemExecutionHost; prefix: string }): void {
    this.domains.remove(input)
  }

  dispatch(input: FilesystemHostDispatch): Promise<FilesystemHostResult> {
    if (this.disposed) {
      return Promise.reject(
        new FilesystemHostSupervisorError('unavailable', 'Filesystem host supervisor is disposed')
      )
    }
    if (
      !['native', 'windows-host'].includes(input.executionHost) ||
      (['wsl', 'unc'].includes(input.storageClass) && input.executionHost !== 'windows-host')
    ) {
      return Promise.reject(
        new FilesystemHostSupervisorError(
          'remote-host',
          'Remote filesystem paths require their owning provider'
        )
      )
    }
    const parsedOperation = filesystemHostOperationSchema.safeParse(input.operation)
    if (!parsedOperation.success) {
      return Promise.reject(
        new FilesystemHostSupervisorError('operation', 'Invalid filesystem host operation')
      )
    }
    if (!Number.isFinite(input.deadlineMs) || input.deadlineMs <= 0) {
      return Promise.reject(
        new FilesystemHostSupervisorError('deadline', 'A positive filesystem deadline is required')
      )
    }
    const normalizedInput = { ...input, operation: parsedOperation.data }
    const retireWhenIdle = normalizedInput.operation.kind === 'classify-path'
    const laneKey = retireWhenIdle
      ? this.domains.classificationLane(
          normalizedInput.executionHost,
          normalizedInput.operation.path
        )
      : this.domains.resolve(normalizedInput.executionHost, normalizedInput.operation.path)
    const lane = this.getLane(laneKey, retireWhenIdle)
    // Why: mirrors the physical-slot reservation — a background burst (startup repo
    // reconcile) must not fill the queue and strand the fs IPC gate every handler awaits.
    const laneLimit =
      normalizedInput.admission === 'foreground'
        ? this.maximumPendingPerLane
        : Math.max(1, this.maximumPendingPerLane - this.foregroundPendingReserve)
    if (lane.pending >= laneLimit) {
      return Promise.reject(
        new FilesystemHostSupervisorError('queue-full', 'Filesystem failure-domain queue is full')
      )
    }
    lane.pending++
    return new Promise((resolve, reject) => {
      lane[normalizedInput.admission].push({ input: normalizedInput, resolve, reject })
      this.pump(lane)
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const lane of this.lanes.values()) {
      const failure = new FilesystemHostSupervisorError(
        'unavailable',
        'Filesystem host supervisor is disposed'
      )
      for (const job of [...lane.foreground.splice(0), ...lane.background.splice(0)]) {
        lane.pending--
        job.reject(failure)
      }
    }
    const retirements: Promise<boolean>[] = []
    for (const lane of this.lanes.values()) {
      if (lane.process) {
        retirements.push(this.retirement.retire(lane.key, lane, lane.process))
      }
    }
    await Promise.all(retirements)
    await Promise.allSettled(this.launches)
  }

  health(): FilesystemHostSupervisorHealth {
    return snapshotFilesystemHostSupervisorHealth({
      physicalChildren: this.capacity.reservedCount,
      abandoned: this.retirement.abandoned,
      didNotExitDomainByChild: this.retirement.didNotExitDomainByChild,
      lanes: this.lanes
    })
  }

  private getLane(key: string, retireWhenIdle = false): FilesystemHostLane {
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = {
        key,
        retireWhenIdle,
        retiring: false,
        breaker: new FilesystemHostBreaker(this.breakerRecoveryDelayMs),
        process: null,
        foreground: [],
        background: [],
        running: false,
        pending: 0
      }
      this.lanes.set(key, lane)
    }
    return lane
  }

  private pump(lane: FilesystemHostLane): void {
    if (lane.running || this.disposed) {
      return
    }
    const job = lane.foreground.shift() ?? lane.background.shift()
    if (!job) {
      return
    }
    lane.running = true
    void executeFilesystemHostDispatch(
      {
        now: this.now,
        launch: (targetLane, admission) => this.launch(targetLane, admission),
        abandon: (laneKey, targetLane, process) => {
          void this.retirement.retire(laneKey, targetLane, process)
        },
        recordTelemetry: (input, targetLane, startedAt, result) =>
          recordFilesystemHostSupervisorTelemetry({
            dispatch: input,
            lane: targetLane,
            startedAt,
            result,
            now: this.now,
            abandonedChildren: this.retirement.abandoned.size,
            emit: this.options.onTelemetry
          })
      },
      lane,
      job
    )
      .then(job.resolve, job.reject)
      .finally(() => {
        lane.pending--
        lane.running = false
        this.pump(lane)
        if (lane.retireWhenIdle && lane.pending === 0) {
          void this.domains.retireIdleLane(lane)
        }
      })
  }

  private hasUnreapedChild(laneKey: string): boolean {
    for (const domain of this.retirement.didNotExitDomainByChild.values()) {
      if (domain === laneKey) {
        return true
      }
    }
    return false
  }

  private launch(
    lane: FilesystemHostLane,
    admission: FilesystemHostAdmissionClass
  ): Promise<FilesystemHostProcessHandle> {
    const launch = this.launchProcess(lane, admission)
    this.launches.add(launch)
    void launch.then(
      () => this.launches.delete(launch),
      () => this.launches.delete(launch)
    )
    return launch
  }

  private async launchProcess(
    lane: FilesystemHostLane,
    admission: FilesystemHostAdmissionClass
  ): Promise<FilesystemHostProcessHandle> {
    // Why: a child wedged in an uninterruptible syscall ignores SIGKILL and never
    // releases its slot, so one dead mount would drain the process-wide budget a
    // child per breaker probe. Its physical exit clears this and reopens the lane.
    if (this.hasUnreapedChild(lane.key)) {
      throw new FilesystemHostSupervisorError(
        'unreaped',
        'Filesystem failure domain still holds an unreaped child'
      )
    }
    let release = this.capacity.reserve(admission)
    if (!release) {
      await reclaimIdleFilesystemHostProcess({
        lanes: this.lanes.values(),
        excludedLane: lane,
        retire: async (idleLane, process) =>
          await this.retirement.retire(idleLane.key, idleLane, process)
      })
      release = this.capacity.reserve(admission)
    }
    while (!release) {
      const retirement = this.retirement.waitForRetirement()
      if (!retirement) {
        break
      }
      await retirement
      release = this.capacity.reserve(admission)
    }
    if (!release) {
      throw new FilesystemHostSupervisorError(
        'capacity',
        'Physical filesystem host capacity is exhausted'
      )
    }
    let process: FilesystemHostProcessHandle | null = null
    process = await this.startProcess({
      entryPath: this.options.entryPath,
      onPhysicalExit: () => {
        release()
        if (process) {
          this.retirement.physicalExit(lane, process)
        }
      }
    })
    this.retirement.track(process, release)
    lane.process = process
    if (this.disposed) {
      await this.retirement.retire(lane.key, lane, process)
      throw new FilesystemHostSupervisorError(
        'unavailable',
        'Filesystem host supervisor is disposed'
      )
    }
    return process
  }
}
