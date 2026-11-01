import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import {
  withAcquiredAgentSessionAccount,
  type ClaudeAccountRecipe
} from '../../shared/agent-session-acquired-account'
import { proveAgentSessionOwner } from './agent-session/ownership/agent-session-lease-transitions'

/** Construction observation and owner proof share the record's existing transaction. */
export function createAgentSessionOwnerProof(
  mutate: (
    id: string,
    transition: (record: AgentSessionRecord) => AgentSessionRecord
  ) => Promise<AgentSessionRecord>,
  leaseTtlMs: number
) {
  return (args: {
    sessionId: string
    fence: number
    link?: AgentSessionProviderHandleLink
    now: number
    leaseTtlMs?: number
    accountAcquisition?: { generation: string; recipe: ClaudeAccountRecipe }
  }): Promise<AgentSessionRecord> =>
    mutate(args.sessionId, (record) =>
      withAcquiredAgentSessionAccount(
        proveAgentSessionOwner({
          record,
          fence: args.fence,
          ...(args.link ? { link: args.link } : {}),
          now: args.now,
          leaseTtlMs: args.leaseTtlMs ?? leaseTtlMs
        }),
        args.accountAcquisition
      )
    )
}
