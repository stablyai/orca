import type {
  FilesystemHostCapacity,
  FilesystemHostAdmissionClass
} from './filesystem-host-capacity'
import type { FilesystemHostProcessRetirement } from './filesystem-host-process-retirement'
import type {
  FilesystemHostLane,
  FilesystemHostProcessHandle
} from './filesystem-host-supervisor-scheduling'
import type { FilesystemHostProcessFactory } from './filesystem-host-supervisor-options'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'
import { reclaimIdleFilesystemHostProcess } from './filesystem-host-idle-process-reclamation'

type LaunchContext = {
  capacity: FilesystemHostCapacity
  retirement: FilesystemHostProcessRetirement
  lanes: Map<string, FilesystemHostLane>
  options: { entryPath: string }
  startProcess: FilesystemHostProcessFactory
  isDisposed: () => boolean
}
export async function launchFilesystemHostProcess(
  context: LaunchContext,
  lane: FilesystemHostLane,
  admission: FilesystemHostAdmissionClass,
  assertActive: () => void
): Promise<FilesystemHostProcessHandle> {
  const checkAdmission = (): void => {
    assertActive()
    if (context.isDisposed()) {
      throw new FilesystemHostSupervisorError(
        'unavailable',
        'Filesystem host supervisor is disposed'
      )
    }
  }
  checkAdmission()
  // Why: a child wedged in an uninterruptible syscall ignores SIGKILL and never
  // releases its slot, so one dead mount would drain the process-wide budget a
  // child per breaker probe. Its physical exit clears this and reopens the lane.
  if ([...context.retirement.didNotExitDomainByChild.values()].includes(lane.key)) {
    throw new FilesystemHostSupervisorError(
      'unreaped',
      'Filesystem failure domain still holds an unreaped child'
    )
  }
  let release = context.capacity.reserve(admission, lane.classification)
  if (!release && (!lane.classification || context.capacity.hasClassifierCapacity)) {
    await reclaimIdleFilesystemHostProcess({
      lanes: context.lanes.values(),
      excludedLane: lane,
      retire: async (idleLane, process) => {
        checkAdmission()
        return await context.retirement.retire(idleLane.key, idleLane, process)
      }
    })
    checkAdmission()
    release = context.capacity.reserve(admission, lane.classification)
  }
  while (!release) {
    const retirement = context.retirement.waitForRetirement()
    if (!retirement) {
      break
    }
    await retirement
    checkAdmission()
    release = context.capacity.reserve(admission, lane.classification)
  }
  if (!release) {
    throw new FilesystemHostSupervisorError(
      'capacity',
      'Physical filesystem host capacity is exhausted'
    )
  }
  let process: FilesystemHostProcessHandle | null = null
  try {
    process = await context.startProcess({
      onSpawn: (child) => {
        process = child
        context.retirement.track(child, release)
        lane.process = child
      },
      entryPath: context.options.entryPath,
      onPhysicalExit: () => {
        release()
        if (process) {
          context.retirement.physicalExit(lane, process)
        }
      }
    })
  } catch (error) {
    if (process) {
      await context.retirement.retire(lane.key, lane, process)
    }
    throw error
  }
  context.retirement.track(process, release)
  lane.process = process
  if (context.isDisposed()) {
    await context.retirement.retire(lane.key, lane, process)
    throw new FilesystemHostSupervisorError('unavailable', 'Filesystem host supervisor is disposed')
  }
  return process
}
