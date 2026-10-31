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

/** Key by agent, account, host and optional project scope; later probes repair login/version drift. */
export type AgentModelCatalogIdentity = {
  agent: string
  /** Native host uses null; each WSL distro has its own CLI. */
  wslDistro: string | null
  /** Include only for catalogs whose membership varies by folder. */
  folder?: string
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
    .update(
      JSON.stringify([
        identity.agent,
        ...parts,
        identity.wslDistro ?? '',
        ...(identity.folder ? [identity.folder] : [])
      ])
    )
    .digest('hex')
}

/** The catalog of the account in `record.accountHome`; a session's reads and saves pass the account
 *  it runs on there, which differs from the one it was created under once the selection moved. */
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
  record: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location'>,
  folder?: string
): string {
  return agentModelCatalogFingerprint({ ...agentModelCatalogIdentityForRecord(record), folder })
}

/** Per-spawn store access; supported structured adapters require native execution. */
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

export function agentModelCatalogScopeFingerprint(
  account: string,
  cwd: string,
  invocation: unknown = null
): string {
  return createHash('sha256')
    .update(JSON.stringify([account, cwd, invocation]))
    .digest('hex')
}
