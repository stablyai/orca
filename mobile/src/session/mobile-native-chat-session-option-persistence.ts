import type { AgentType } from '../../../src/shared/agent-status-types'
import type { StructuredSessionOptionPick } from '../../../src/shared/structured-agent-session-options'
import type { RpcClient } from '../transport/rpc-client'

/** The host owns the record a later launch seeds from, so a phone-side pick writes there
 *  rather than to any client-local store. Best-effort: a failed write only costs the
 *  next session its remembered start. */
export function persistMobileStructuredOptionPicks(args: {
  client: RpcClient | null
  agent: AgentType
  picks: readonly StructuredSessionOptionPick[]
}): Promise<void> {
  const { agent, client, picks } = args
  if (!client || picks.length === 0) {
    return Promise.resolve()
  }
  return client
    .sendRequest('settings.mutateNativeChatSessionOptions', {
      type: 'apply-picks',
      agent,
      picks
    })
    .then(() => undefined)
    .catch(() => undefined)
}
