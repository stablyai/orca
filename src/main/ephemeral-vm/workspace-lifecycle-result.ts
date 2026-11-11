import type {
  EphemeralVmRuntimeRecord,
  EphemeralVmWorkspaceLifecycleResult
} from '../../shared/ephemeral-vm-runtimes'
import { ephemeralVmFailureFromError } from '../../shared/ephemeral-vm-failure-copy'

/** Thrown IPC errors keep only the message; a value keeps the code for the renderer catalog. */
export async function toWorkspaceLifecycleResult(
  run: () => Promise<EphemeralVmRuntimeRecord | null>
): Promise<EphemeralVmWorkspaceLifecycleResult> {
  try {
    return { ok: true, runtime: await run() }
  } catch (error) {
    return { ok: false, ...ephemeralVmFailureFromError(error) }
  }
}
