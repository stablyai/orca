import type { DispatchCreator } from '../../../../orchestration/db/dispatch-depth'
import {
  sessionCallerOf,
  type OrchestrationEntryCaller
} from '../../../../orchestration/addressing/orchestration-caller-identity'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { orchestrationCallerIdentity } from './run-scope'
import { runtimeChatHost } from '../../../../../external-conversations/external-conversation-chat'

/** Use runtime-attested pane/incarnation for nesting identity; remote attachment matching requires the exact process and params are untrusted. */
export function resolveDispatchCreator(
  runtime: OrcaRuntimeService,
  callerHandle: string | undefined,
  callerSession: OrchestrationEntryCaller | undefined
): DispatchCreator {
  if (!callerHandle) {
    // No declared caller resolves no parent; retain legacy Run-binding depth zero.
    return { kind: 'system' }
  }
  const caller = orchestrationCallerIdentity(runtime, {
    handle: callerHandle,
    session: callerSession,
    paneKey: null
  })
  // A chat's workers report where the turn that started them came from.
  const chatSession = sessionCallerOf(callerSession)
  const turnSource =
    chatSession &&
    runtime
      .getExternalConversationSeam()
      ?.conversationTurn(runtimeChatHost(runtime), chatSession.sessionId)
      ? { turnSource: 'connector' as const }
      : {}
  if (caller.terminalHandle === null) {
    // A handle-less session: its Orca session id is its whole identity.
    return caller.orcaSessionId
      ? { kind: 'session', orcaSessionId: caller.orcaSessionId, ...turnSource }
      : { kind: 'system' }
  }
  const authority = runtime.getOrchestrationDispatchAuthority?.(caller.terminalHandle)
  return {
    kind: 'terminal',
    handle: caller.terminalHandle,
    paneKey:
      authority?.paneKey ??
      caller.paneKey ??
      runtime.getTerminalPaneKey(caller.terminalHandle) ??
      undefined,
    processIncarnation: authority?.processIncarnation ?? undefined,
    ...(caller.orcaSessionId ? { orcaSessionId: caller.orcaSessionId } : {}),
    ...turnSource
  }
}
