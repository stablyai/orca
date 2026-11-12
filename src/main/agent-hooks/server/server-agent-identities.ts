import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { agentIdentityDatabasePath } from '../identity/agent-identity-store'
import { agentSightingOf, PaneAgentIdentities } from '../identity/pane-agent-identities'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerState } from './server-state'

/** Terminal agent ids are named when a row is admitted, so walks and publications only copy them. */
export abstract class AgentHookServerAgentIdentities extends AgentHookServerState {
  protected readonly agentIdentities = new PaneAgentIdentities(() =>
    this.lastStatusFilePath ? agentIdentityDatabasePath(this.lastStatusFilePath) : null
  )

  // A prototype getter: the base class reads it while its own fields initialize.
  protected override get legacyRowHooks() {
    return {
      prepareRow: (entry: AgentHookEventPayload, previous: AgentHookEventPayload | undefined) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
        const row = entry as EnrichedAgentHookEventPayload
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
        const before = previous as EnrichedAgentHookEventPayload | undefined
        const identity = this.agentIdentities.assign(
          agentSightingOf(row),
          row.agentIdentity ?? before?.agentIdentity
        )
        if (identity) {
          row.agentIdentity = identity
        } else {
          delete row.agentIdentity
        }
      },
      rowChanged: (key: string, entry: AgentHookEventPayload | undefined) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
        const identity = (entry as EnrichedAgentHookEventPayload | undefined)?.agentIdentity
        this.agentIdentities.setPlace(key, key.split('\0', 1)[0] ?? key, identity)
      }
    }
  }
}
