import { setGitAdmissionCountsProvider } from './git-admission-census'
import type { GitAdmissionGrant, GitAdmissionRequest } from './git-admission-state'
import type { GitAdmissionScheduler } from './git-subprocess-admission'

type SchedulerFactory = () => GitAdmissionScheduler

export function createGitAdmissionRuntime(createScheduler: SchedulerFactory) {
  let scheduler = createScheduler()
  setGitAdmissionCountsProvider(() => scheduler.censusCounts())
  return {
    acquire(request: GitAdmissionRequest): Promise<GitAdmissionGrant> {
      return process.env.ORCA_GIT_ADMISSION_DISABLED === '1'
        ? Promise.resolve({ queueWaitMs: 0, release: () => {} })
        : scheduler.acquire(request)
    },
    reset(replacement: GitAdmissionScheduler = createScheduler()): void {
      scheduler = replacement
    },
    snapshot(): ReturnType<GitAdmissionScheduler['snapshot']> {
      return scheduler.snapshot()
    }
  }
}
