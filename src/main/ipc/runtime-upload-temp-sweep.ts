import { setTimeout } from 'node:timers/promises'
import type { RuntimeUploadFileStreamRequest } from '../../shared/runtime-upload-staging-contract'
import { callRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'

const RUNTIME_UPLOAD_SWEEP_ATTEMPTS = 2
const RUNTIME_UPLOAD_SWEEP_SETTLE_MS = 250

/** Sweep twice: one in-flight append can recreate a deleted temp file; sequential slices bound this to one late write. */
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
