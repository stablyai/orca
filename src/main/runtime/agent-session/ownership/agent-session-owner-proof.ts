import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type {
  AgentSessionAccountHome,
  AgentSessionLaunchedAccount
} from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  withAcquiredAgentSessionAccount,
  type ClaudeAccountRecipe
} from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import { proveAgentSessionOwner } from './agent-session-lease-transitions'

/** A chat with no conversation yet that launched in another home keeps that home from now on;
 *  one with a conversation never moves, since its history lives where it started. */
export function withMovedAccountHome<T extends AgentSessionRecord>(
  proved: T,
  record: AgentSessionRecord,
  moved: AgentSessionAccountHome | undefined
): T {
  return moved && record.providerHandleChain.length === 0
    ? { ...proved, accountHome: moved }
    : proved
}

/** Where the runtime at `fence` launched, when its provider reports a home or a saved account.
 *  A saved account alone (agy's) ran in the home the record keeps, or the one it moved to. */
export function launchedAgentSessionAccount(
  record: AgentSessionRecord,
  args: {
    fence: number
    launchedAccountHome?: AgentSessionAccountHome
    launchedAccountId?: string
    movedAccountHome?: AgentSessionAccountHome
  }
): AgentSessionLaunchedAccount | undefined {
  const accountHome =
    args.launchedAccountHome ??
    (args.launchedAccountId
      ? withMovedAccountHome(record, record, args.movedAccountHome).accountHome
      : undefined)
  if (!accountHome) {
    return undefined
  }
  return {
    fence: args.fence,
    accountHome,
    ...(args.launchedAccountId ? { accountId: args.launchedAccountId } : {})
  }
}

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
    /** The saved account it launched on, where one home holds several. */
    launchedAccountId?: string
    /** The home a chat with no conversation yet moved to at this launch. */
    movedAccountHome?: AgentSessionAccountHome
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
      const launchedAccount = launchedAgentSessionAccount(record, args)
      const launched = launchedAccount ? { ...proved, launchedAccount } : proved
      return withMovedAccountHome(launched, record, args.movedAccountHome)
    })
}
