import {
  FilesystemFailureDomainRegistry,
  type FilesystemExecutionHost
} from './filesystem-host-failure-domain'
import type { FilesystemHostProcessRetirement } from './filesystem-host-process-retirement'
import type { FilesystemHostLane } from './filesystem-host-supervisor-scheduling'

export class FilesystemHostFailureDomainCoordinator {
  private readonly registry = new FilesystemFailureDomainRegistry()

  constructor(
    private readonly lanes: Map<string, FilesystemHostLane>,
    private readonly retirement: FilesystemHostProcessRetirement
  ) {}

  publish(input: {
    executionHost: FilesystemExecutionHost
    prefix: string
    mountId: string
  }): void {
    const orphanedLaneKeys = this.registry.publish(input)
    const activeLane = this.lanes.get(`${input.executionHost}:${input.mountId}`)
    if (activeLane) {
      activeLane.retireWhenIdle = false
    }
    for (const laneKey of orphanedLaneKeys) {
      this.markLaneForRetirement(laneKey)
    }
  }

  remove(input: { executionHost: FilesystemExecutionHost; prefix: string }): void {
    for (const laneKey of this.registry.remove(input)) {
      this.markLaneForRetirement(laneKey)
    }
  }

  resolve(executionHost: FilesystemExecutionHost, path: string): string {
    return this.registry.resolve(executionHost, path)
  }

  classificationLane(executionHost: FilesystemExecutionHost, path: string): string {
    return this.registry.classificationLane(executionHost, path)
  }

  async retireIdleLane(lane: FilesystemHostLane): Promise<void> {
    if (!lane.retireWhenIdle || lane.running || lane.pending > 0 || lane.retiring) {
      return
    }
    lane.retiring = true
    const process = lane.process
    if (process) {
      await this.retirement.retire(lane.key, lane, process)
    }
    lane.retiring = false
    if (lane.retireWhenIdle && lane.pending === 0 && !lane.running && lane.process === null) {
      this.lanes.delete(lane.key)
    }
  }

  private markLaneForRetirement(laneKey: string): void {
    const lane = this.lanes.get(laneKey)
    if (!lane) {
      return
    }
    lane.retireWhenIdle = true
    if (lane.pending === 0) {
      void this.retireIdleLane(lane)
    }
  }
}
