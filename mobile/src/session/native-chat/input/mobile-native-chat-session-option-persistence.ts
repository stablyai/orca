import type { AgentType } from '../../../../../src/shared/agent-status-types'
import type { NativeChatSessionOptionSettingsMutation } from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import type { StructuredSessionOptionPick } from '../../../../../src/shared/structured-agent-session-options'
import type { RpcClient } from '../../../transport/rpc-client'
import { nativeChatSessionOptionsWrite } from '../../mobile-session-launch-operations'

// Persist on the host that seeds future sessions; best-effort failure only loses that next-session default.
export function writeMobileNativeChatSessionOptions(
  client: RpcClient,
  mutation: NativeChatSessionOptionSettingsMutation
): Promise<void> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the catalog names the five TUI agents and the two settable option shapes; the composer's own types are wider, and narrowing either here would change the bytes main put on the wire.
  const params = mutation as Parameters<typeof nativeChatSessionOptionsWrite.request>[1]
  return nativeChatSessionOptionsWrite
    .request(client, params)
    .then(() => undefined)
    .catch(() => undefined)
}

export function persistMobileStructuredOptionPicks(args: {
  client: RpcClient | null
  agent: AgentType
  picks: readonly StructuredSessionOptionPick[]
}): Promise<void> {
  const { agent, client, picks } = args
  if (!client || picks.length === 0) {
    return Promise.resolve()
  }
  return writeMobileNativeChatSessionOptions(client, {
    type: 'apply-picks',
    agent,
    picks: [...picks]
  })
}
