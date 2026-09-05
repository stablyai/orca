/**
 * The workspace a dispatching pane sits in, for either kind of coordinator.
 *
 * `showTerminal` resolves a live PTY or a live renderer leaf, and a worker that IS a structured
 * agent session has neither — so routing every coordinator through it would have made "can dispatch
 * sub-workers" a property of how the coordinator itself was started. The worker mode is a runtime
 * implementation detail: an agent is taught the same verbs and reads the same receipts either way,
 * so the one fact `worker-start` actually needs from `--from` is resolved from the same authority
 * the pane-key and process-incarnation getters already use.
 *
 * Deliberately NOT a `showTerminal` branch: that returns a `RuntimeTerminalShow` with a ptyId, a
 * leaf id and a pane runtime id, and synthesising those for a session with no PTY would hand every
 * caller of a public terminal verb something that looks writable and is not.
 */

import type { OrcaRuntimeService } from '../../orca-runtime'
import { isStructuredWorkerHandle } from '../../structured-worker-identity'

export async function resolveDispatchCallerWorktreeId(
  runtime: Pick<OrcaRuntimeService, 'showTerminal' | 'getOrchestrationDispatchAuthority'>,
  callerHandle: string
): Promise<string> {
  if (isStructuredWorkerHandle(callerHandle)) {
    const worktreeId = runtime.getOrchestrationDispatchAuthority?.(callerHandle)?.worktreeId ?? null
    if (worktreeId) {
      return worktreeId
    }
  }
  return (await runtime.showTerminal(callerHandle)).worktreeId
}
