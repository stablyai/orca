import { createHash } from 'node:crypto'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentModelCatalogSessionAccess,
  AgentModelCatalogStore
} from './agent-model-catalog-store'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../../shared/agent-session-account-home'

/**
 * Everything that changes which models a listing can answer with: the agent,
 * the account home the CLI reads credentials/config from, and the execution
 * host that runs the binary. Login-state or CLI-version drift under the same
 * key is corrected by the next refresh, never by the fingerprint.
 */
export type AgentModelCatalogIdentity = {
  agent: string
  /** Null on the native host; WSL distros each carry their own CLI. */
  wslDistro: string | null
} & (
  | { accountHomeVariable: string; accountHomePath: string; accountHome?: never }
  | { accountHome: AgentSessionAccountHome; accountHomeVariable?: never; accountHomePath?: never }
)

export function agentModelCatalogFingerprint(identity: AgentModelCatalogIdentity): string {
  const account = identity.accountHome
  const parts = account
    ? isLegacyAgentSessionAccountHome(account)
      ? [account.variable, account.path]
      : [account.kind, account.locator]
    : [identity.accountHomeVariable, identity.accountHomePath]
  return createHash('sha256')
    .update(JSON.stringify([identity.agent, ...parts, identity.wslDistro ?? '']))
    .digest('hex')
}

/** The durable record pins the account home at launch, so this names the
 *  catalog THAT session lists from — not whichever account is selected now. */
export function agentModelCatalogIdentityForRecord(
  record: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location'>
): AgentModelCatalogIdentity {
  return {
    agent: record.provider,
    accountHome: record.accountHome,
    wslDistro: record.location.wslDistro
  }
}

export function agentModelCatalogFingerprintForRecord(
  record: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location'>
): string {
  return agentModelCatalogFingerprint(agentModelCatalogIdentityForRecord(record))
}

/** A live session's store handle, pinned to the account home it spawned under.
 *  Native only: both structured adapters refuse non-native locations at launch. */
export function agentModelCatalogSessionAccess(
  store: AgentModelCatalogStore | undefined,
  agent: { agent: string; accountHomeVariable: string },
  accountHomePath: string | null
): AgentModelCatalogSessionAccess | undefined {
  if (!store || !accountHomePath) {
    return undefined
  }
  return {
    store,
    fingerprint: agentModelCatalogFingerprint({
      agent: agent.agent,
      accountHomeVariable: agent.accountHomeVariable,
      accountHomePath,
      wslDistro: null
    }),
    accountHomePath
  }
}
