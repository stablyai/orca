import type { AgentHookServer } from './server'

type Server = Pick<
  AgentHookServer,
  | 'getStatusSnapshot'
  | 'getStatusSnapshotForPane'
  | 'checkAgentPresence'
  | 'reconcileEndedProcessForPaneKeys'
  | 'attestCompatibilityAuthority'
  | 'retirePaneAuthority'
  | 'setPaneLaunchAuthorityReader'
>

/** How every host's runtime reads and clears the agent-hook status store. One copy, so the desktop,
 *  orcad and the specs cannot drift on what a command end or an ended process passes through. */
export function agentHookStatusStoreRuntimeDeps(server: Server) {
  return {
    // Why: worktree.ps pulls hook-reported agent status (same source as the desktop sidebar) at
    // query time so mobile shows the same agents.
    getAgentStatusSnapshot: () =>
      server.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    // Why: the filter above hides resume-identity rows from the live-agent views, but those rows
    // carry the provider session mobile native chat addresses transcripts by — Pi publishes
    // identity that way and would otherwise be unreachable.
    getAgentProviderSessionSnapshot: () => server.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey: string) =>
      server.getStatusSnapshotForPane(paneKey),
    checkHookAgentPresence: (paneKey: string) => server.checkAgentPresence(paneKey),
    reconcileAgentStatusForEndedProcess: (
      ...args: Parameters<AgentHookServer['reconcileEndedProcessForPaneKeys']>
    ) => {
      server.reconcileEndedProcessForPaneKeys(...args)
    }
  }
}

/** Orchestration launch authority: the hook server attests it, the runtime retires it. */
export function agentHookLaunchAuthorityRuntimeDeps(server: Server) {
  return {
    attestAgentHookCompatibilityAuthority: (
      candidate: Parameters<AgentHookServer['attestCompatibilityAuthority']>[0]
    ) => server.attestCompatibilityAuthority(candidate),
    retireAgentHookCompatibilityAuthority: (
      paneKey: string,
      options?: Parameters<AgentHookServer['retirePaneAuthority']>[2]
    ) => server.retirePaneAuthority(paneKey, undefined, options)
  }
}

/** Why: the runtime owns which launch token a pane still honours; the hook server derives from it. */
export function wireRuntimeLaunchAuthorityReader(
  server: Server,
  runtime: { readPaneLaunchAuthority(paneKey: string): { launchTokenHash: string | null } | null }
): void {
  server.setPaneLaunchAuthorityReader((paneKey) => runtime.readPaneLaunchAuthority(paneKey))
}
