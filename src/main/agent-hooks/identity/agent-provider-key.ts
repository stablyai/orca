import { dirname, join } from 'node:path'

/** One provider conversation as seen from one execution host; '' is the "none" sentinel so the
 *  UNIQUE index applies to every row. */
export type AgentProviderKey = {
  executionHost: string
  wslDistro: string
  agent: string
  providerSessionId: string
  locator: string
}

export function agentIdentityDatabasePath(lastStatusPath: string): string {
  return join(dirname(lastStatusPath), 'agent-identities.db')
}

export function sameProviderKey(left: AgentProviderKey, right: AgentProviderKey): boolean {
  return (
    left.providerSessionId === right.providerSessionId &&
    left.agent === right.agent &&
    left.wslDistro === right.wslDistro &&
    left.locator === right.locator &&
    left.executionHost === right.executionHost
  )
}
