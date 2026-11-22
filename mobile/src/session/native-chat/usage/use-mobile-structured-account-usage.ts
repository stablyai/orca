import { useCallback, useMemo } from 'react'
import type { AgentSessionAccountUsage } from '../../../../../src/shared/agent-session/lifecycle/accounts/agent-session-account-usage'
import { AGENT_SESSION_PHONE_ACCOUNT_USAGE_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { useRouteRelaysCapability } from '../../../worktree/execution-hosts/workspace-server-context'
import type { MobileStructuredAgentSessionArgs } from '../agent-session/mobile-structured-agent-session-contract'
import { callAgentSession } from '../agent-session/mobile-structured-agent-session-rpc'

// The host gives Codex 40 s to answer.
const ACCOUNT_USAGE_TIMEOUT_MS = 45_000

export type MobileStructuredAccountUsage = {
  read: () => Promise<AgentSessionAccountUsage>
}

/** `/usage`: the chat's Codex account usage, offered where the host reports it and lets a phone read it. */
export function useMobileStructuredAccountUsage(
  session: Pick<
    MobileStructuredAgentSessionArgs,
    'client' | 'sessionId' | 'hostSupport' | 'enabled'
  >,
  reported: boolean
): MobileStructuredAccountUsage | null {
  const { client, sessionId } = session
  const relayed = useRouteRelaysCapability(AGENT_SESSION_PHONE_ACCOUNT_USAGE_RUNTIME_CAPABILITY)
  const offered =
    session.enabled &&
    reported &&
    relayed &&
    session.hostSupport?.phoneAccountUsage === true &&
    !!client &&
    !!sessionId
  const read = useCallback(async (): Promise<AgentSessionAccountUsage> => {
    if (!client || !sessionId) {
      return { status: 'failed' }
    }
    return await callAgentSession<AgentSessionAccountUsage>(
      client,
      'agentSession.accountUsage',
      { sessionId },
      ACCOUNT_USAGE_TIMEOUT_MS
    ).catch((): AgentSessionAccountUsage => ({ status: 'failed' }))
  }, [client, sessionId])
  return useMemo(() => (offered ? { read } : null), [offered, read])
}
