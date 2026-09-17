import { agentHookServer } from '../agent-hooks/server'
import type { VerifiedAgentDiscovery } from '../../shared/agent-status-verified-discovery'
import type {
  RuntimeAgentSessionCommit,
  RuntimeAgentSessionInventoryReconciliation
} from './runtime-terminal-contracts'

export function publishCommittedAgentSessionMembership(commit: RuntimeAgentSessionCommit): void {
  agentHookServer.admitAgentSessionOwner({
    owner: commit.result.owner,
    paneKey: commit.paneKey,
    tabId: commit.tabId,
    worktreeId: commit.worktreeId,
    connectionId: commit.connectionId,
    terminalHandle: commit.result.owner.surface.terminalHandle,
    agentType: commit.agentType ?? commit.result.owner.claim.agent,
    launchToken: commit.launchToken,
    disposition: commit.result.disposition
  })
}

/**
 * Manual-process adoption is injected because it needs a PTY owner registry, and only the
 * composition root knows which one it owns. Importing the main-process registry here would also
 * pull node-pty into the daemon bundle's static graph.
 */
export function createAgentSessionMembershipReconciler(
  admitLocalDiscoveries?: (discoveries: readonly VerifiedAgentDiscovery[]) => void
): (reconciliation: RuntimeAgentSessionInventoryReconciliation) => void {
  return (reconciliation) => {
    agentHookServer.reconcileAgentLaunchMembership(reconciliation.owners, {
      complete: reconciliation.complete,
      ...(reconciliation.connectionId !== undefined
        ? { connectionId: reconciliation.connectionId }
        : {})
    })
    // Only the execution host that supplied process and ancestry proof can adopt a manual process.
    if (reconciliation.connectionId === null) {
      admitLocalDiscoveries?.(reconciliation.discoveries)
    }
  }
}
