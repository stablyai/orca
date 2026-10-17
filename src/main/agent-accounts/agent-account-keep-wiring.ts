import { agentHookServer } from '../agent-hooks/server'
import { getCodexPaneAccount, setCodexPaneKept } from '../codex/codex-pane-account-registry'
import { keepStaleCodexPanes } from '../codex/codex-stale-pane-accounts'
import { getPtyIdForPaneKey, ptyPaneKey } from '../ipc/pty/pane/key-state'
import type { AgentKeepDeps } from './agent-account-keep'
import { getAgentRunAccounts, getKeptAgentConversations } from './agent-run-accounts-installed'

/** Null where the producer is not installed (orcad): there, keeping is not offered. */
export function installedAgentKeepDeps(): AgentKeepDeps | null {
  const producer = getAgentRunAccounts()
  const kept = getKeptAgentConversations()
  if (!producer || !kept) {
    return null
  }
  return {
    getRow: (paneKey) => agentHookServer.getRunAccountRow(paneKey),
    refresh: (paneKey) => producer.refresh(paneKey),
    withdraw: (paneKey) => producer.withdraw(paneKey),
    kept,
    getPtyIdForPaneKey,
    getPaneKeyForPty: (ptyId) => ptyPaneKey.get(ptyId),
    readCodexRecord: getCodexPaneAccount,
    setCodexPaneKept,
    keepStaleCodexPanes
  }
}
