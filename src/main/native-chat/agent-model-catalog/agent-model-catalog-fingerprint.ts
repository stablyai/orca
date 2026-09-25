import { createHash } from 'node:crypto'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentModelCatalogSessionAccess,
  AgentModelCatalogStore
} from './agent-model-catalog-store'

/**
 * Everything that changes which models a listing can answer with: the agent,
 * the account home the CLI reads credentials/config from, and the execution
 * host that runs the binary. Login-state or CLI-version drift under the same
 * key is corrected by the next refresh, never by the fingerprint.
 */
export type AgentModelCatalogIdentity = {
  agent: 'claude' | 'codex'
  accountHomeVariable: string
  accountHomePath: string
  /** Null on the native host; WSL distros each carry their own CLI. */
  wslDistro: string | null
}

export function agentModelCatalogFingerprint(identity: AgentModelCatalogIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        identity.agent,
        identity.accountHomeVariable,
        identity.accountHomePath,
        identity.wslDistro ?? ''
      ])
    )
    .digest('hex')
}

/** The durable record pins the account home at launch, so this names the
 *  catalog THAT session lists from — not whichever account is selected now. */
export function agentModelCatalogIdentityForRecord(
  record: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location'>
): AgentModelCatalogIdentity {
  return {
    agent: record.provider,
    accountHomeVariable: record.accountHome.variable,
    accountHomePath: record.accountHome.path,
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
  agent: 'claude' | 'codex',
  accountHomePath: string | null
): AgentModelCatalogSessionAccess | undefined {
  if (!store || !accountHomePath) {
    return undefined
  }
  return {
    store,
    fingerprint: agentModelCatalogFingerprint({
      agent,
      accountHomeVariable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      accountHomePath,
      wslDistro: null
    }),
    accountHomePath
  }
}
