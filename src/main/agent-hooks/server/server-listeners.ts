import { cliWriterExecutionMatcher, type CliWriterExecutionMatches } from './cli-writer-observation'
import { isTmuxInnerSubject } from '../../../shared/tmux-agent-hook-owner'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload
} from '../../../shared/agent-status-types'
import type { ClaudeStatusLineRateLimits } from '../../../shared/claude-statusline-rate-limits'
import type { HookTransportInterferenceReport } from '../../../shared/agent-hook-transport-interference'
import {
  getLegacyStatusListingOrder,
  type HookListenerState
} from '../../../shared/agent-hook-listener/listener-state'
import type {
  AgentHookAuthorityEvidence,
  AgentHookProviderSessionIdentity,
  AgentHookStatusChangeEntry,
  AgentHookStatusFreshnessObservation,
  EnrichedAgentHookEventPayload,
  StatusDropListener
} from './server-types'
import { toAgentStatusIpcPayload } from './server-status-identity'
import { AgentHookServerAuthorityProjection } from './server-authority-projection'
import { serializeAgentStatusSubject } from '../../../shared/agent-status-subject'
import { structuredStatusLegacyEvent } from './server-structured-status-row'
import { PaneTimers } from './program-status/pane-timers'
import { ProgramStatusFacetStore } from './program-status/facet-store'

// Why: the listing counter starts at 1, so an unassigned row must sort last — never above every ordered row.
const UNORDERED_STATUS_ROW = Number.MAX_SAFE_INTEGER

export abstract class AgentHookServerListeners extends AgentHookServerAuthorityProjection {
  protected cliWriterExecutionMatches: CliWriterExecutionMatches | null = null

  setCliWriterExecutionMatcher(...args: Parameters<typeof cliWriterExecutionMatcher>): void {
    this.cliWriterExecutionMatches = cliWriterExecutionMatcher(...args)
  }
  // Why here: every publish below stitches from it, and all later layers manage its lifecycle.
  protected readonly programStatusFacets = new ProgramStatusFacetStore()
  /** Yielded OSC 7501 reports, re-offered when hook precedence lapses: programs never resend a state. */
  protected readonly hookSilenceRechecks = new PaneTimers()
  /** Trailing facet-only republishes: progress and message ticks can arrive at PTY chunk rate. */
  protected readonly programStatusFacetRepublishes = new PaneTimers()

  setStartupPromptClaimListener(
    listener: (body: unknown) => boolean | 'pending',
    clear: () => void
  ): void {
    this.onStartupPromptClaim = listener
    this.clearStartupPromptClaims = clear
  }

  protected publishAuthorityCorrelation(paneKey: string): void {
    for (const row of this.combinedStatusEntries()) {
      if (row.paneKey === paneKey) {
        this.onAgentStatus?.({ ...row, isReplay: true })
      }
    }
    this.notifyStatusChangeListeners()
  }

  protected emitEnrichedStatus(row: EnrichedAgentHookEventPayload): void {
    const enriched = this.programStatusFacets.stitch(
      this.projectLaunchAuthority(
        row,
        this.state.lastStatusByPaneKey.has(row.paneKey) ? row : this.authoritySubject(row.paneKey)
      )
    )
    this.onAgentStatus?.(enriched)
    for (const listener of this.enrichedStatusListeners) {
      try {
        listener(enriched)
      } catch (err) {
        console.error('[agent-hooks] enriched status listener threw', err)
      }
    }
  }

  _resetCanonicalStatusForTests(): void {
    this.resetCanonicalStatus()
  }

  private combinedStatusEntries(): EnrichedAgentHookEventPayload[] {
    const rows: { entry: EnrichedAgentHookEventPayload; order: number }[] = []
    for (const [paneKey, entry] of this.state.lastStatusByPaneKey) {
      rows.push({
        entry: this.programStatusFacets.stitch(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; shared listeners expose only the base event type.
          this.projectLaunchAuthority(entry as EnrichedAgentHookEventPayload)
        ),
        order: getLegacyStatusListingOrder(this.state, paneKey) ?? UNORDERED_STATUS_ROW
      })
    }
    for (const parent of this.canonicalStatusStore.getParents()) {
      if (!parent.status || isTmuxInnerSubject(parent.subject)) {
        continue
      }
      rows.push({
        entry: this.projectLaunchAuthority(structuredStatusLegacyEvent(parent.status), parent),
        order:
          this.canonicalListingOrder.get(serializeAgentStatusSubject(parent.subject)) ??
          UNORDERED_STATUS_ROW
      })
    }
    return rows.sort((a, b) => a.order - b.order).map(({ entry }) => entry)
  }
  /**
   * Notified once per process when repeated hook POSTs are cut off mid-body (#11217).
   * Why: the listener fails open on every request error, so without this the only symptom is
   * agent status quietly going stale — for every runtime at once, since they share this transport.
   */
  setTransportInterferenceListener(
    listener: ((report: HookTransportInterferenceReport) => void) | null
  ): void {
    this.onTransportInterference = listener
  }

  setListener(listener: ((payload: EnrichedAgentHookEventPayload) => void) | null): void {
    this.onAgentStatus = listener
    if (!listener) {
      return
    }
    // Why: replay is best-effort per pane so one throwing listener can't starve the rest.
    for (const payload of this.combinedStatusEntries()) {
      try {
        listener({ ...payload, isReplay: true })
      } catch (err) {
        console.error('[agent-hooks] replay listener threw', err)
      }
    }
  }

  // Why: statusline posts carry live Claude usage windows, not agent status; they feed RateLimitService directly.
  setClaudeStatusLineListener(
    listener: ((event: ClaudeStatusLineRateLimits) => void) | null
  ): void {
    this.onClaudeStatusLine = listener
  }

  subscribeStatusChanges(listener: (statuses: AgentHookStatusChangeEntry[]) => void): () => void {
    this.statusChangeListeners.add(listener)
    return () => {
      this.statusChangeListeners.delete(listener)
    }
  }

  /** Accepted duplicate evidence renews leases without becoming a semantic row mutation. */
  subscribeStatusFreshness(
    listener: (status: AgentHookStatusFreshnessObservation) => void
  ): () => void {
    this.statusFreshnessListeners.add(listener)
    return () => {
      this.statusFreshnessListeners.delete(listener)
    }
  }

  protected emitStatusFreshnessObservation(status: AgentHookStatusFreshnessObservation): void {
    for (const listener of this.statusFreshnessListeners) {
      try {
        listener(status)
      } catch (err) {
        console.error('[agent-hooks] status-freshness listener threw', err)
      }
    }
  }

  subscribeProviderSessionChanges(
    listener: (providerSessions: AgentHookProviderSessionIdentity[]) => void
  ): () => void {
    this.providerSessionChangeListeners.add(listener)
    return () => {
      this.providerSessionChangeListeners.delete(listener)
    }
  }

  /** Multi-subscriber tap on definitive live-row deletions. `dropStatusEntry` is a user
   * dismissal, so it never routes through the pane-status-clear fan-out — pane-owned
   * cleanup (synthetic spinners) still has to retire with the row it was driving. */
  subscribeStatusDrop(listener: StatusDropListener): () => void {
    this.statusDropListeners.add(listener)
    return () => {
      this.statusDropListeners.delete(listener)
    }
  }

  protected emitStatusDropped(paneKey: string): void {
    for (const listener of this.statusDropListeners) {
      // Why: matches every other fan-out here — one throwing subscriber must not strand the rest.
      try {
        listener(paneKey)
      } catch (err) {
        console.error('[agent-hooks] status-drop listener threw', err)
      }
    }
  }

  /** Multi-subscriber tap on every enriched status change (no replay). */
  subscribeEnrichedStatus(listener: (payload: EnrichedAgentHookEventPayload) => void): () => void {
    this.enrichedStatusListeners.add(listener)
    return () => {
      this.enrichedStatusListeners.delete(listener)
    }
  }

  /** Replay is durable evidence from a prior runtime, not a live observation. */
  protected withdrawReplayObservation(paneKey: string): void {
    if (this.runtimeObservedStatusPaneKeys.delete(paneKey)) {
      this.notifyStatusChangeListeners()
    }
  }

  setPaneStatusClearListener(listener: ((clear: AgentStatusClearIpcPayload) => void) | null): void {
    this.onPaneStatusCleared = listener
  }

  /** Multi-subscriber tap on pane status clears. Unlike `setPaneStatusClearListener`
   *  (a single slot the main window owns and drops on close) this survives window
   *  teardown and exists at all under headless serve, which never opens one. */
  subscribePaneStatusClear(listener: (clear: AgentStatusClearIpcPayload) => void): () => void {
    this.paneStatusClearListeners.add(listener)
    return () => {
      this.paneStatusClearListeners.delete(listener)
    }
  }

  protected emitPaneStatusCleared(clear: AgentStatusClearIpcPayload): void {
    this.onPaneStatusCleared?.(clear)
    for (const listener of this.paneStatusClearListeners) {
      // Why: callers are pane/connection teardown paths; one throwing subscriber must
      // not strand the rest, matching every other fan-out here.
      try {
        listener(clear)
      } catch (err) {
        console.error('[agent-hooks] pane-status-clear listener threw', err)
      }
    }
  }

  /** Snapshot of cached statuses in IPC shape. Used by `agentStatus:getSnapshot` after tabs hydrate so the
   *  dashboard catches up on hook events that fired during startup. */
  getStatusSnapshot(): AgentStatusIpcPayload[] {
    return this.combinedStatusEntries().map(toAgentStatusIpcPayload)
  }

  /** Provider-session identities, including Pi's metadata-only rows. */
  getProviderSessionIdentities(): AgentHookProviderSessionIdentity[] {
    return this.buildStatusChangeNotification().providerSessions
  }

  getStatusSnapshotForPane(paneKey: string): AgentStatusIpcPayload[] {
    const legacy = this.state.lastStatusByPaneKey.get(paneKey)
    if (legacy) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
      const row = legacy as EnrichedAgentHookEventPayload
      return [
        toAgentStatusIpcPayload(this.programStatusFacets.stitch(this.projectLaunchAuthority(row)))
      ]
    }
    const rows: AgentStatusIpcPayload[] = []
    for (const subject of this.canonicalSubjectsByPane.get(paneKey)?.values() ?? []) {
      const parent = this.canonicalStatusStore
        .getParents()
        .find(
          (record) =>
            serializeAgentStatusSubject(record.subject) === serializeAgentStatusSubject(subject)
        )
      if (parent?.status) {
        rows.push(this.projectLaunchAuthority(parent.status, parent))
      }
    }
    return rows
  }

  getHydratedAuthorityCommitments(): readonly AgentHookAuthorityEvidence[] {
    return this.hydratedAuthorityCommitments
  }

  getCurrentAuthorityObservations(): readonly AgentHookAuthorityEvidence[] {
    return Object.freeze(
      Array.from(this.currentAuthorityObservations.values(), (entry) =>
        Object.freeze({ ...entry.evidence })
      )
    )
  }

  protected buildStatusChangeNotification(): {
    statuses: AgentHookStatusChangeEntry[]
    providerSessions: AgentHookProviderSessionIdentity[]
  } {
    const statuses: AgentHookStatusChangeEntry[] = []
    const providerSessions: AgentHookProviderSessionIdentity[] = []
    for (const enriched of this.combinedStatusEntries()) {
      const paneKey = enriched.paneKey
      if (enriched.providerSession) {
        providerSessions.push({
          paneKey,
          sessionId: enriched.providerSession.id,
          ...(enriched.providerSession.transcriptPath
            ? { transcriptPath: enriched.providerSession.transcriptPath }
            : {}),
          ...(enriched.worktreeId ? { worktreeId: enriched.worktreeId } : {})
        })
      }
      if (!enriched.providerSessionOnly) {
        statuses.push({
          paneKey,
          state: enriched.payload.state,
          receivedAt: enriched.receivedAt,
          observedInCurrentRuntime:
            Boolean(enriched.structuredHost) || this.runtimeObservedStatusPaneKeys.has(paneKey)
        })
      }
    }
    return { statuses, providerSessions }
  }

  protected notifyStatusChangeListeners(): void {
    if (this.statusChangeListeners.size === 0 && this.providerSessionChangeListeners.size === 0) {
      return
    }
    const { statuses, providerSessions } = this.buildStatusChangeNotification()
    for (const listener of this.statusChangeListeners) {
      try {
        listener(statuses)
      } catch (err) {
        console.error('[agent-hooks] status-change listener threw', err)
      }
    }
    for (const listener of this.providerSessionChangeListeners) {
      try {
        listener(providerSessions)
      } catch (err) {
        console.error('[agent-hooks] provider-session listener threw', err)
      }
    }
  }

  getStatusChangeSnapshot(): AgentHookStatusChangeEntry[] {
    return this.buildStatusChangeNotification().statuses
  }

  /** Test-only accessor for the per-instance listener state (narrow getter avoids an `as unknown` cast). */
  _getStateForTests(): HookListenerState {
    return this.state
  }
}
