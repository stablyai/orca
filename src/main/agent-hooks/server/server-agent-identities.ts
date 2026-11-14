import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { admitLegacyAgentStatus } from '../../../shared/agent-hook-listener/listener-state'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status/transport/agent-status-legacy-adapter'
import { agentIdentityDatabasePath, sameProviderKey } from '../identity/agent-provider-key'
import {
  agentProviderKeyOf,
  agentSightingOf,
  PaneAgentIdentities,
  type ProviderSessionSighting,
  type SettledAgentIdentityPlace
} from '../identity/pane-agent-identities'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { OrcaSessionId } from '../../../shared/orca-session-address'

import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  AgentIdentityWorkerClient,
  type AgentIdentityClient
} from '../identity/agent-identity-worker-client'
import { AgentHookServerStatusQueries } from './server-status-queries'
import { structuredStatusLegacyEvent } from './server-structured-status-row'

type SleepingAgentSighting = Pick<
  SleepingAgentSessionRecord,
  'agent' | 'providerSession' | 'connectionId'
>

/** Terminal agent ids are named when a row is admitted, so walks and publications only copy them. */
export abstract class AgentHookServerAgentIdentities extends AgentHookServerStatusQueries {
  private identityPath: { from: string | null; path: string | null } = { from: null, path: null }
  protected readonly agentIdentities = new PaneAgentIdentities(
    // Read on every admission, so derived once per status path.
    () => {
      const from = this.lastStatusFilePath
      if (from !== this.identityPath.from) {
        this.identityPath = { from, path: from ? agentIdentityDatabasePath(from) : null }
      }
      return this.identityPath.path
    },
    (settled) => this.publishSettledAgentIdentities(settled),
    () => this.createAgentIdentityClient()
  )

  /** The status path names the identity store, so each change ends or starts its authority
   *  here, outside any admission. */
  protected setStatusFilePath(path: string | null): void {
    this.lastStatusFilePath = path
    this.agentIdentities.syncAuthority()
  }

  /** One lazy identity worker per hook-server owner. */
  protected createAgentIdentityClient(): AgentIdentityClient {
    return new AgentIdentityWorkerClient()
  }

  /** Tab snapshot rows copy ids, so a settled id clears them. */
  protected providerRowsByTab: Map<string, AgentStatusIpcPayload[]> | null = null

  /** Window readers and session.tabs see a row's new id with no hook event attached, so no
   *  transition effect or enriched subscriber runs again. */
  protected abstract publishAgentIdentityProjection(row: EnrichedAgentHookEventPayload): void

  /** A committed answer, or the end of the authority that gave one, re-stamps the current rows
   *  on its key and republishes each as a projection: status, clocks and order stay as they are. */
  private publishSettledAgentIdentities(settled: SettledAgentIdentityPlace[]): void {
    const projections: EnrichedAgentHookEventPayload[] = []
    for (const { place, paneKey, canonicalSubject, identity } of settled) {
      if (canonicalSubject) {
        const subject = this.canonicalSubjectsByPane.get(paneKey)?.get(canonicalSubject)
        const status = subject && this.canonicalStatusStore.getParent(subject)?.status
        if (status) {
          projections.push({ ...structuredStatusLegacyEvent(status), agentIdentity: identity })
        }
        continue
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
      const row = this.state.lastStatusByPaneKey.get(place) as
        | EnrichedAgentHookEventPayload
        | undefined
      const carried = row?.agentIdentity
      // The row may have moved on to another key since the request; only its own key settles.
      if (
        !carried ||
        !sameProviderKey(carried.key, identity.key) ||
        this.agentIdentities.isCurrent(carried) ||
        (carried.pending && identity.pending)
      ) {
        continue
      }
      const next = { ...row, agentIdentity: identity }
      if (
        admitLegacyAgentStatus(
          this.state,
          'main-status-update',
          next,
          AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
        )
      ) {
        projections.push(next)
      }
    }
    // Readers of the projection must not see the cached ids it replaces.
    this.providerRowsByTab = null
    for (const projection of projections) {
      this.publishAgentIdentityProjection(projection)
    }
  }

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

  /** Panes proven to run terminal agent `id` now; null when this host never minted it. A miss
   *  in the live index awaits the store, since a dormant conversation keeps its id. */
  async terminalAgentPlaces(
    id: string
  ): Promise<{ paneKey: string; worktreeId?: string }[] | null> {
    const authority = this.agentIdentities.authority()
    const known = await this.agentIdentities.isTerminalIdentity(id)
    // An owner that ended during the wait proves nothing, not even an empty terminal.
    if (known !== true || authority !== this.agentIdentities.generation) {
      return null
    }
    // Read the index after the await, so the places are the rows now, not when asked.
    const places: { paneKey: string; worktreeId?: string }[] = []
    for (const place of this.agentIdentities.placesOf(id)) {
      // Canonical rows are never hydrated; a legacy row counts only once this runtime observed it,
      // since a saved status (even Done) cannot prove its process survived Orca being closed.
      const subject = place.canonical
        ? this.canonicalSubjectsByPane.get(place.paneKey)?.get(place.key)
        : undefined
      const row = place.canonical
        ? subject && this.canonicalStatusStore.getParent(subject)?.status
        : this.runtimeObservedStatusPaneKeys.has(place.key)
          ? this.state.lastStatusByPaneKey.get(place.key)
          : undefined
      // Resume seeds, exited agents and unconfirmed restored rows prove no running agent.
      if (
        row &&
        !('paneSleep' in row && row.paneSleep) &&
        row.providerSessionOnly !== true &&
        row.restoredUnconfirmed !== true &&
        !('agentPresence' in row && row.agentPresence?.ended === true)
      ) {
        places.push({
          paneKey: place.paneKey,
          ...(row.worktreeId ? { worktreeId: row.worktreeId } : {})
        })
      }
    }
    return places
  }

  /** The pane's terminal agent id, keyed as Copy Session ID picks its id: a confirmed live row
   *  (legacy or tmux-selected) wins even without a provider session; only an absent or
   *  unconfirmed row falls back to the pane's sleeping record. An explicit request: it waits for
   *  a pending lookup, or retries a failed one even during the backoff. */
  async resolvePaneAgentId(
    paneKey: string,
    readSleeping: () => SleepingAgentSighting | undefined
  ): Promise<OrcaSessionId | null> {
    // Before selection, so a first click's lazy store start is not taken for its end.
    const authority = this.agentIdentities.authority()
    const selected = this.paneAgentSighting(paneKey, readSleeping)
    if (!selected || selected.id) {
      return selected?.id ?? null
    }
    const id = await this.agentIdentities.identify(selected.sighting)
    // The owner may have closed, or the pane moved to another conversation, during the wait.
    if (authority !== this.agentIdentities.generation) {
      return null
    }
    const current = this.paneAgentSighting(paneKey, readSleeping)
    const asked = agentProviderKeyOf(selected.sighting)
    const now = current && agentProviderKeyOf(current.sighting)
    return asked && now && sameProviderKey(asked, now) ? id : null
  }

  private paneAgentSighting(
    paneKey: string,
    readSleeping: () => SleepingAgentSighting | undefined
  ): { sighting: ProviderSessionSighting; id?: OrcaSessionId } | null {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
    const legacy = this.state.lastStatusByPaneKey.get(resolved) as
      | EnrichedAgentHookEventPayload
      | undefined
    const live = legacy ?? this.getTmuxSelectedStatus(resolved)
    if (live && live.restoredUnconfirmed !== true) {
      return live.structuredHost
        ? null
        : {
            sighting: agentSightingOf(live),
            ...(live.agentIdentity?.id && this.agentIdentities.isCurrent(live.agentIdentity)
              ? { id: live.agentIdentity.id }
              : {})
          }
    }
    const sleeping = readSleeping()
    // Sleeping records carry no WSL distro; a woken agent's own hook names it. A record from a
    // foreign connection (a direct SSH relay) names no conversation on this host.
    if (!sleeping || process.platform === 'win32') {
      return null
    }
    return {
      sighting: {
        agent: sleeping.agent,
        providerSession: sleeping.providerSession,
        connectionId: sleeping.connectionId ?? null
      }
    }
  }
}
