import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { assertWslUncPathRunning } from '../wsl/wsl-unc-access-gate'

/**
 * Paired phone, web and CLI clients poll Git followers no user is looking at; a stopped distro
 * refuses them (E9), as the desktop IPC twin does. The refusal reaches every client version as a
 * plain `runtime_error` carrying its message.
 */
export async function assertRuntimeReadWslDistroRunning(
  target: { worktree: { path: string }; executionHostId: ExecutionHostId },
  wslDistro?: string | null
): Promise<void> {
  if (target.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return
  }
  await assertWslUncPathRunning(target.worktree.path, wslDistro)
}
