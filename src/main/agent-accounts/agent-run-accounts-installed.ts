// Why type-only: spawn paths import this module, and the producer's graph must not load in workers.
import type { AgentRunAccounts, PaneLaunchFact } from './agent-run-accounts'
import type { KeptAgentConversations } from './kept-agent-conversations'

export type InstalledAgentRunAccounts = {
  producer: AgentRunAccounts
  kept: KeptAgentConversations
}

let installed: InstalledAgentRunAccounts | undefined

/** Installed beside the account services (desktop and `orca serve`); orcad has none. */
export function installAgentRunAccounts(services: InstalledAgentRunAccounts | undefined): void {
  installed = services
}

export function getAgentRunAccounts(): AgentRunAccounts | undefined {
  return installed?.producer
}

export function getKeptAgentConversations(): KeptAgentConversations | undefined {
  return installed?.kept
}

/** Called by both spawn-commit paths; a facet failure must never fail a spawn. */
export function noteAgentPaneLaunch(fact: PaneLaunchFact): void {
  try {
    installed?.producer.notePaneLaunch(fact)
  } catch (error) {
    console.warn('[agent-run-accounts] Could not note a pane launch:', error)
  }
}
