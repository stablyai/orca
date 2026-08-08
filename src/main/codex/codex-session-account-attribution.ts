import type { AgentHookProviderSessionIdentity } from '../agent-hooks/server'
import type { CodexPaneAccountRecord } from './codex-pane-account-registry'

export function captureCodexSessionAccountAttributions(
  identities: readonly AgentHookProviderSessionIdentity[],
  deps: {
    getPtyIdForPaneKey(paneKey: string): string | undefined
    getPaneAccount(ptyId: string): CodexPaneAccountRecord | null
    recordSessionAccount(sessionId: string, accountId: string | null): boolean
  }
): number {
  let captured = 0
  for (const identity of identities) {
    if (identity.agentType !== 'codex' || identity.observedInCurrentRuntime !== true) {
      continue
    }
    const ptyId = deps.getPtyIdForPaneKey(identity.paneKey)
    const launchAccount = ptyId ? deps.getPaneAccount(ptyId) : null
    if (launchAccount && deps.recordSessionAccount(identity.sessionId, launchAccount.accountId)) {
      captured++
    }
  }
  return captured
}
