import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcContext } from '../../../rpc/core'
import { remoteForwardRequestId } from './remote-owned-calls'

/**
 * Who is asking, as a retry of the same request must find it again: the caller's session, else
 * its terminal's pane, which survives a restart, else the person at this Orca outside any terminal.
 * Never one shared identity for every terminal, so two callers reusing an ID never collide.
 */
export function remoteForwardCallerNamespace(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationDb' | 'getTerminalPaneKey'>,
  ctx: Pick<RpcContext, 'orchestrationCaller' | 'orchestrationCompatibilityEvidence'>,
  callerHandle: string | undefined
): string {
  const session = ctx.orchestrationCaller?.orcaSessionId
  if (session) {
    return `session:${session}`
  }
  const handle = callerHandle ?? ctx.orchestrationCompatibilityEvidence?.terminalHandle
  const pane =
    ctx.orchestrationCompatibilityEvidence?.paneKey ??
    (handle ? runtime.getTerminalPaneKey(handle) : null)
  return pane
    ? `pane:${pane}`
    : `local:${runtime.getOrchestrationDb().getOrCreateLocalMutationCallerFingerprint()}`
}

/** The key a forwarded call goes out under, and how to say it back in the caller's own terms. */
export type RemoteForwardKey = { key: string; requestId: string }

export function remoteForwardKey(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationDb' | 'getTerminalPaneKey'>,
  ctx: Pick<RpcContext, 'orchestrationCaller' | 'orchestrationCompatibilityEvidence'>,
  callerHandle: string | undefined,
  requestId: string | undefined
): RemoteForwardKey | undefined {
  return requestId
    ? {
        key: remoteForwardRequestId(
          remoteForwardCallerNamespace(runtime, ctx, callerHandle),
          requestId
        ),
        requestId
      }
    : undefined
}
