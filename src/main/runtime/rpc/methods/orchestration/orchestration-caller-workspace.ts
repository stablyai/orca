/** Resolve structured coordinators through session authority, as pane/incarnation getters do.
 * showTerminal requires a real PTY; fabricating its writable fields would break terminal verbs for chat workers. */

import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationEntryCaller } from '../../../orchestration/addressing/orchestration-caller-identity'
import { isStructuredWorkerHandle } from '../../../../../shared/orchestration/workers/structured-worker-handle'

export async function resolveDispatchCallerWorktreeId(
  runtime: Pick<OrcaRuntimeService, 'showTerminal' | 'getOrchestrationDispatchAuthority'>,
  callerHandle: string,
  callerSession: OrchestrationEntryCaller | undefined
): Promise<string> {
  // A paired Orca has no workspace here, so `current` and `new-child` refuse as for an unmanaged one.
  if (callerSession?.kind === 'peer') {
    return PEER_COORDINATOR_HAS_NO_WORKSPACE
  }
  // A session caller's workspace is on its record, whichever owner (chat or terminal) holds it.
  if (callerSession) {
    return callerSession.workspaceId
  }
  if (isStructuredWorkerHandle(callerHandle)) {
    const worktreeId = runtime.getOrchestrationDispatchAuthority?.(callerHandle)?.worktreeId ?? null
    if (worktreeId) {
      return worktreeId
    }
  }
  return (await runtime.showTerminal(callerHandle)).worktreeId
}

const PEER_COORDINATOR_HAS_NO_WORKSPACE = 'peer-coordinator-has-no-workspace'
