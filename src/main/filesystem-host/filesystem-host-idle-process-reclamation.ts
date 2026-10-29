import type {
  FilesystemHostLane,
  FilesystemHostProcessHandle
} from './filesystem-host-supervisor-scheduling'

export async function reclaimIdleFilesystemHostProcess(options: {
  lanes: Iterable<FilesystemHostLane>
  excludedLane: FilesystemHostLane
  retire: (lane: FilesystemHostLane, process: FilesystemHostProcessHandle) => Promise<boolean>
}): Promise<boolean> {
  for (const lane of options.lanes) {
    const process = lane.process
    if (!process || lane === options.excludedLane || lane.running || lane.pending > 0) {
      continue
    }
    if (await options.retire(lane, process)) {
      return true
    }
  }
  return false
}
