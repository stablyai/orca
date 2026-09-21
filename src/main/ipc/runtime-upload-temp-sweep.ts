import { setTimeout } from 'node:timers/promises'
import type { RuntimeUploadFileStreamRequest } from '../../shared/runtime-upload-staging-contract'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

const RUNTIME_UPLOAD_SWEEP_ATTEMPTS = 2
const RUNTIME_UPLOAD_SWEEP_SETTLE_MS = 250

/**
 * Sweep an abandoned upload temp path after an abort.
 *
 * Aborting rejects the in-flight chunk locally, but the host may still apply
 * that append — and appends open with `flag: 'a'`, which recreates the file a
 * delete just removed. Slices are strictly sequential, so at most one append
 * can be outstanding: a second pass after it has had time to land is enough.
 *
 * Best-effort throughout. The runtime may be why the upload failed, and a
 * failed cleanup of a hidden temp file is not actionable.
 */
export async function sweepAbandonedRuntimeUploadTempPath(
  userDataPath: string,
  args: RuntimeUploadFileStreamRequest
): Promise<void> {
  for (let attempt = 0; attempt < RUNTIME_UPLOAD_SWEEP_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await setTimeout(RUNTIME_UPLOAD_SWEEP_SETTLE_MS)
    }
    try {
      await callRuntimeEnvironment(
        userDataPath,
        args.environmentId,
        'files.delete',
        {
          worktree: args.worktree,
          relativePath: args.relativePath,
          recursive: false,
          expectedSshTargetId: args.expectedSshTargetId,
          expectedSshConnectionGeneration: args.expectedSshConnectionGeneration,
          expectedExecutionHostId: args.expectedExecutionHostId
        },
        15_000,
        args.expectedEnvironmentPairingRevision,
        undefined,
        { expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId }
      )
    } catch {
      // Nothing to escalate; the next pass (if any) still runs.
    }
  }
}
