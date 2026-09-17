import { admitVerifiedAgentDiscovery } from '../../shared/agent-status-verified-discovery'
import type { VerifiedAgentDiscovery } from '../../shared/agent-status-verified-discovery'
import { makePaneKey } from '../../shared/stable-pane-id'
import { agentHookServer } from '../agent-hooks/server'
import { agentSessionOwners } from '../ipc/pty/pane/agent-session-owners'

/** Admit discoveries proven by the local execution host through the canonical owner transaction. */
export function admitLocalVerifiedAgentDiscoveries(
  discoveries: readonly VerifiedAgentDiscovery[]
): void {
  for (const discovery of discoveries) {
    void admitVerifiedAgentDiscovery({ owners: agentSessionOwners, discovery }).then((result) => {
      if (!result.admitted) {
        return
      }
      const paneKey = makePaneKey(result.owner.surface.tabId, result.owner.surface.leafId)
      agentHookServer.admitAgentSessionOwner({
        owner: result.owner,
        paneKey,
        tabId: result.owner.surface.tabId,
        worktreeId: result.owner.surface.worktreeId,
        connectionId: null,
        terminalHandle: result.owner.surface.terminalHandle,
        agentType: result.owner.claim.agent,
        disposition: result.disposition
      })
    })
  }
}
