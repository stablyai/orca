/** Resolve structured coordinators through session authority, as pane/incarnation getters do.
 * showTerminal requires a real PTY; fabricating its writable fields would break terminal verbs for chat workers. */

import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationSessionCaller } from '../../orchestration/orchestration-caller-identity'
import { isStructuredWorkerHandle } from '../../../../shared/structured-worker-handle'

export async function resolveDispatchCallerWorktreeId(
  runtime: Pick<OrcaRuntimeService, 'showTerminal' | 'getOrchestrationDispatchAuthority'>,
  callerHandle: string,
  callerSession: OrchestrationSessionCaller | undefined
): Promise<string> {
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
