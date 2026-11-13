import { GitAdmissionScheduler } from '../../../../shared/git/admission/git-admission-scheduler'
import type {
  GitAdmissionGrant,
  GitAdmissionRequest
} from '../../../../shared/git/admission/git-admission-state'
import { resolveGitAdmissionTier } from './git-operation-executor'

let scheduler = new GitAdmissionScheduler()

export function acquireGitAdmission(request: GitAdmissionRequest): Promise<GitAdmissionGrant> {
  if (process.env.ORCA_GIT_ADMISSION_DISABLED === '1') {
    return Promise.resolve({ queueWaitMs: 0, release: () => {} })
  }
  return scheduler.acquire({ ...request, tier: resolveGitAdmissionTier(request.tier) })
}

/** A timed-out caller can settle before its child exits; the slot frees when the child does. */
export function releaseGitAdmissionAfter(
  termination: Promise<void> | null,
  grant: Pick<GitAdmissionGrant, 'release'>
): void {
  if (termination) {
    void termination.then(grant.release)
  } else {
    grant.release()
  }
}

export function _resetGitAdmissionForTests(replacement = new GitAdmissionScheduler()): void {
  scheduler = replacement
}

export function _gitAdmissionSnapshotForTests(): ReturnType<GitAdmissionScheduler['snapshot']> {
  return scheduler.snapshot()
}
