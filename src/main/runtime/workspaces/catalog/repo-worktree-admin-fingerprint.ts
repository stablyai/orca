import { WorkerThreadRequestQueue } from '../../../worker-threads/worker-thread-request-queue'
import { forkWorkerRequestTransport } from '../../../worker-threads/forked-worker-request-transport'
import { getForkedChildEntryPath } from '../../../worker-threads/forked-child-entry-path'
import type {
  RepoFingerprintRequest,
  RepoFingerprintResponse
} from './repo-worktree-admin-fingerprint-protocol'
import {
  GIT_ADMIN_PROBE_UNAVAILABLE,
  type GitAdminProbeResult
} from '../../../../shared/git/metadata/git-admin-probe-result'

const PROBE_TIMEOUT_MS = 3_500
const RETRY_DELAY_MS = 30_000
let retryAt = 0

const requests = new WorkerThreadRequestQueue<RepoFingerprintRequest, RepoFingerprintResponse>({
  factory: () =>
    forkWorkerRequestTransport(
      getForkedChildEntryPath('repo-worktree-admin-fingerprint-process-entry.js')
    ),
  idleTeardownMs: 60_000,
  queueCap: { maxQueuedCalls: 64, describeFull: () => 'Git fingerprint queue is full' },
  maxConsecutiveDeaths: 1,
  awaitRetirement: true,
  createUnavailableError: (message) => new Error(message),
  describeTimeout: () => 'Git fingerprint process timed out',
  describeExit: (code) => `Git fingerprint process exited (${code})`,
  describeCrashLoop: (error) => error,
  onUnavailable: () => undefined
})

/** Unknown fingerprints retain the caller's existing cache/fallback policy. */
export async function readRepoWorktreeAdminFingerprint(
  repoPath: string
): Promise<GitAdminProbeResult> {
  if (Date.now() < retryAt) {
    return GIT_ADMIN_PROBE_UNAVAILABLE
  }
  try {
    const response = await requests.dispatch(
      (id) => ({ id, repoPath }),
      PROBE_TIMEOUT_MS,
      AbortSignal.timeout(PROBE_TIMEOUT_MS)
    )
    return response.fingerprint
  } catch {
    retryAt = Date.now() + RETRY_DELAY_MS
    return GIT_ADMIN_PROBE_UNAVAILABLE
  }
}
