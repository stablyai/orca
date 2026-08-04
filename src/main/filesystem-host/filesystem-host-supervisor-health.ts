import type { FilesystemHostBreakerState } from './filesystem-host-breaker'
import type {
  FilesystemHostLane,
  FilesystemHostProcessHandle
} from './filesystem-host-supervisor-scheduling'

export type FilesystemHostSupervisorHealth = {
  physicalChildren: number
  abandonedChildren: number
  didNotExitDomains: number
  breakers: Record<string, FilesystemHostBreakerState>
}

export function snapshotFilesystemHostSupervisorHealth(input: {
  physicalChildren: number
  abandoned: Set<FilesystemHostProcessHandle>
  didNotExitDomainByChild: Map<FilesystemHostProcessHandle, string>
  lanes: Map<string, FilesystemHostLane>
}): FilesystemHostSupervisorHealth {
  return {
    physicalChildren: input.physicalChildren,
    abandonedChildren: input.abandoned.size,
    didNotExitDomains: new Set(input.didNotExitDomainByChild.values()).size,
    breakers: Object.fromEntries(
      [...input.lanes].map(([key, lane]) => [key, lane.breaker.snapshot().state])
    )
  }
}
