import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import {
  withAcquiredAgentSessionAccount,
  type ClaudeAccountRecipe
} from '../../../../shared/agent-session/lifecycle/agent-session-acquired-account'
import { proveAgentSessionOwner } from './agent-session-lease-transitions'

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
    /** The account this runtime launched under, when the provider reports one. */
    launchedAccountHome?: AgentSessionAccountHome
  }): Promise<AgentSessionRecord> =>
    mutate(args.sessionId, (record) => {
      const { launchedAccount: _previous, ...proved } = withAcquiredAgentSessionAccount(
        proveAgentSessionOwner({
          record,
          fence: args.fence,
          ...(args.link ? { link: args.link } : {}),
          now: args.now,
          leaseTtlMs: args.leaseTtlMs ?? leaseTtlMs
        }),
        args.accountAcquisition
      )
      // A runtime that reports no account leaves no stale claim about where this fence ran.
      return args.launchedAccountHome
        ? {
            ...proved,
            launchedAccount: { fence: args.fence, accountHome: args.launchedAccountHome }
          }
        : proved
    })
}
