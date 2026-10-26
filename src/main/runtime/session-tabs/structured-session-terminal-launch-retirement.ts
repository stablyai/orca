import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { TerminalLaunchResult } from '../../../shared/agent-session-resume'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { listStructuredProviderSessionOwnership } from '../../native-chat/agent-session-wire/structured-provider-session-ownership'
import {
  keysMayMatch,
  terminalConversationKey
} from '../../native-chat/structured-conversation-key'

/** Presentation only: a delayed successful spawn must never close a newer native child. */
export async function retireChatForAdmittedTerminalLaunch(
  runtime: { retireStructuredAgentSessionTabFromSnapshot(sessionId: string): boolean } | undefined,
  args: { resumeOrigin?: unknown; worktreeId?: unknown },
  result: TerminalLaunchResult & { isReattach?: boolean }
): Promise<void> {
  const decision = result.savedResumeDecision
  if (
    args.resumeOrigin !== 'switch' ||
    result.isReattach ||
    decision?.verdict !== 'admitted' ||
    result.agentResumeRefused ||
    result.agentResumeUnavailable
  ) {
    return
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  const key = terminalConversationKey(decision.agent, decision.providerSession.id)
  const holders = listStructuredProviderSessionOwnership(host.deps.store.listRecords()).filter(
    (holding) => holding.role === 'head' && keysMayMatch(holding.key, key)
  )
  for (const holding of holders) {
    const record = host.deps.store.getRecord(holding.sessionId)
    if (
      record?.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      record.location.workspaceId !== args.worktreeId
    ) {
      continue
    }
    try {
      await host.setSessionTabVisibility(holding.sessionId, false)
    } catch (error) {
      // The terminal is admitted regardless of a failed visibility write; never stop another child.
      host.deps.logger.warn('recording a switched chat tab retirement failed', {
        scope: 'switch-tab-retirement',
        sessionId: holding.sessionId,
        error
      })
    }
    try {
      runtime?.retireStructuredAgentSessionTabFromSnapshot(holding.sessionId)
    } catch (error) {
      host.deps.logger.warn('publishing a switched chat tab retirement failed', {
        scope: 'switch-tab-retirement',
        sessionId: holding.sessionId,
        error
      })
    }
  }
}
