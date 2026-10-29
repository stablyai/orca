import type {
  FilesystemHostLane,
  FilesystemHostProcessHandle
} from './filesystem-host-supervisor-scheduling'

export class FilesystemHostProcessRetirement {
  readonly abandoned = new Set<FilesystemHostProcessHandle>()
  readonly didNotExitDomainByChild = new Map<FilesystemHostProcessHandle, string>()
  private readonly releaseByChild = new Map<FilesystemHostProcessHandle, () => void>()
  private readonly retirements = new Map<FilesystemHostProcessHandle, Promise<boolean>>()

  track(process: FilesystemHostProcessHandle, release: () => void): void {
    this.releaseByChild.set(process, release)
  }

  physicalExit(lane: FilesystemHostLane, process: FilesystemHostProcessHandle): void {
    this.releaseByChild.get(process)?.()
    this.clear(lane, process)
  }

  async retire(
    laneKey: string,
    lane: FilesystemHostLane,
    process: FilesystemHostProcessHandle
  ): Promise<boolean> {
    const existing = this.retirements.get(process)
    if (existing) {
      return await existing
    }
    const retirement = this.retireProcess(laneKey, lane, process).finally(() => {
      if (this.retirements.get(process) === retirement) {
        this.retirements.delete(process)
      }
    })
    this.retirements.set(process, retirement)
    return await retirement
  }

  waitForRetirement(): Promise<boolean> | null {
    const retirements = [...this.retirements.values()]
    return retirements.length > 0 ? Promise.race(retirements) : null
  }

  private async retireProcess(
    laneKey: string,
    lane: FilesystemHostLane,
    process: FilesystemHostProcessHandle
  ): Promise<boolean> {
    if (lane.process === process) {
      lane.process = null
    }
    this.abandoned.add(process)
    const didExit = await process.retire().catch(() => false)
    if (didExit) {
      this.physicalExit(lane, process)
    } else {
      this.didNotExitDomainByChild.set(process, laneKey)
    }
    return didExit
  }

  private clear(lane: FilesystemHostLane, process: FilesystemHostProcessHandle): void {
    this.releaseByChild.delete(process)
    this.abandoned.delete(process)
    this.didNotExitDomainByChild.delete(process)
    if (lane.process === process) {
      lane.process = null
    }
  }
}
