import type { AgentType } from '../../../../../src/shared/agent-status-types'
import type { StructuredSessionOptionPick } from '../../../../../src/shared/structured-agent-session-options'
import type { RpcClient } from '../../../transport/rpc-client'
import { nativeChatSessionOptionsWrite } from '../../mobile-session-launch-operations'

// Persist picks on the host that seeds future sessions; best-effort failure only loses that next-session default.
export function persistMobileStructuredOptionPicks(args: {
  client: RpcClient | null
  agent: AgentType
  picks: readonly StructuredSessionOptionPick[]
}): Promise<void> {
  const { agent, client, picks } = args
  if (!client || picks.length === 0) {
    return Promise.resolve()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the catalog names the five TUI agents and the two settable option shapes; the composer's own types are wider, and narrowing either here would change the bytes main put on the wire.
  const params = { type: 'apply-picks', agent, picks: [...picks] } as Parameters<
    typeof nativeChatSessionOptionsWrite.request
  >[1]
  return nativeChatSessionOptionsWrite
    .request(client, params)
    .then(() => undefined)
    .catch(() => undefined)
}
