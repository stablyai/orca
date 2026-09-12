import { paneHasStateClaims } from '../../../shared/agent-hook-listener/listener-state'
import type { AgentStatusCacheIdentity } from '../../../shared/agent-status-types'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerAuthorityFences } from './server-authority-fences'
import {
  agentStatusSubjectKey,
  type AgentStatusSubject
} from '../../../shared/agent-status-subject'

export abstract class AgentHookServerCleanup extends AgentHookServerAuthorityFences {
  /** The resume-identity remnant of a dropped row: a `providerSessionOnly` entry carries no state
   *  claim — it cannot gate a pane `working` — so it survives teardowns that end the pane's live
   *  claims. Returns null when the row has no resumable session to keep. */
  protected toRetainedProviderSessionRow(
    entry: EnrichedAgentHookEventPayload | null | undefined
  ): EnrichedAgentHookEventPayload | null {
    if (
      !entry?.providerSession ||
      !entry.payload.agentType ||
      entry.payload.agentType === 'unknown'
    ) {
      return null
    }
    const { launchToken: _launchToken, ...resumeIdentity } = entry
    return { ...resumeIdentity, providerSessionOnly: true, retainedForLiveness: true }
  }

  /** Drop only the status row (user dismissal); do NOT wipe prompt/tool caches since the pane's agent may still be alive. Use clearPaneState for PTY-teardown. */
  dropStatusEntry(
    paneKey: string,
    /** Defaults to true: a dismissed pane can still be resumed in place. A structured session has
     *  no pane to resume into and its record store owns resume identity, so it passes false. */
    options?: { preserveResumeIdentity?: boolean }
  ): void {
    const deleted = this.deleteStatusEntry(paneKey, { preserveAuthority: true })
    this.finishDroppedStatusEntry(deleted, options)
  }

  /** Typed store API; unlike the legacy pane alias it can address one host-scoped row exactly. */
  dropStatusSubject(
    subject: AgentStatusSubject,
    options?: { preserveResumeIdentity?: boolean }
  ): void {
    const deleted = this.deleteStatusEntryForSubject(subject, { preserveAuthority: true })
    this.finishDroppedStatusEntry(deleted, options)
  }

  private finishDroppedStatusEntry(
    deleted: EnrichedAgentHookEventPayload | null,
    options?: { preserveResumeIdentity?: boolean }
  ): void {
    if (!deleted) {
      return
    }
    const retained =
      options?.preserveResumeIdentity === false ? null : this.toRetainedProviderSessionRow(deleted)
    if (retained) {
      this.setStatusEntry(retained)
    }
    this.commitStatusRowMutation(deleted, retained)
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    this.emitStatusDropped(deleted.paneKey)
  }

  /** Evict a UI-cleared status only if no newer status has replaced it. */
  dropPersistedStatusEntry(identity: AgentStatusCacheIdentity): boolean {
    return this.dropPersistedStatusEntries([identity]).length > 0
  }

  /** Batch form: one persist and one listener notification for the whole set. Returns the
   *  pane keys that were actually evicted. */
  dropPersistedStatusEntries(identities: readonly AgentStatusCacheIdentity[]): string[] {
    const evicted: string[] = []
    for (const identity of identities) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(identity.paneKey)
      const existing = identity.subject
        ? this.statusEntryForSubject(identity.subject)
        : this.latestStatusEntryForPaneKey(resolvedPaneKey)
      // Why: stateStartedAt pins the turn; the renderer's updatedAt is stamped at or after this
      // receivedAt (runtime-sync and recovery paths use Date.now()/capturedAt), so a strictly
      // newer cached event is the only replacement worth protecting.
      if (
        !existing ||
        existing.stateStartedAt !== identity.stateStartedAt ||
        existing.receivedAt > identity.receivedAt
      ) {
        continue
      }
      const deleted = identity.subject
        ? this.deleteStatusEntryForSubject(identity.subject, { preserveAuthority: true })
        : this.deleteStatusEntry(resolvedPaneKey, { preserveAuthority: true })
      if (!deleted) {
        continue
      }
      const retained = this.toRetainedProviderSessionRow(deleted)
      if (retained) {
        this.setStatusEntry(retained)
      }
      this.commitStatusRowMutation(deleted, retained)
      evicted.push(deleted.paneKey)
    }
    if (evicted.length === 0) {
      return evicted
    }
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    for (const paneKey of evicted) {
      this.emitStatusDropped(paneKey)
    }
    return evicted
  }

  /** Retire panes whose owning process is certifiably dead.
   *
   *  The ordinary teardown already does this: every attributable PTY exit reaches
   *  `clearProviderPtyState`, which resolves the pane key and calls `clearPaneState`. But that
   *  resolution depends on the spawn-time `ptyPaneKey` mapping, which a restored/reattached PTY may
   *  never rebuild — so those panes keep a `working` row and its latches for good, with no hook left
   *  to retire them. This is the same operation reached from the runtime's own pane-key knowledge,
   *  so a dead pane is cleaned up identically however its keys were resolved. */
  reconcileEndedProcessForPaneKeys(
    paneKeys: Iterable<string>,
    options?: {
      /** The pane's PTY outlived its agent (a confirmed shell foreground), so the session can still
       *  be resumed in place — keep the `providerSessionOnly` remnant the paired `agentStatus:drop`
       *  minted for exactly this case. A certified PTY exit passes nothing: there is no pane left to
       *  resume into, and dropping it matches what `clearProviderPtyState` already does. */
      preserveResumeIdentity?: boolean
    }
  ): number {
    // A certified PTY exit passes no resume identity; a surviving shell may opt into the remnant.
    let cleared = 0
    for (const paneKey of paneKeys) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      if (!this.hasLiveClaimsForPaneKey(resolvedPaneKey)) {
        continue
      }
      const retained = options?.preserveResumeIdentity
        ? this.toRetainedProviderSessionRow(this.latestStatusEntryForPaneKey(resolvedPaneKey))
        : null
      const previous = this.latestStatusEntryForPaneKey(resolvedPaneKey)
      this.clearPaneState(resolvedPaneKey, { emitStatusRowMutation: false })
      if (retained) {
        this.setStatusEntry(retained)
        this.scheduleStatusPersist()
        this.notifyStatusChangeListeners()
      }
      this.commitStatusRowMutation(previous, retained)
      cleared += 1
    }
    return cleared
  }

  /** Anything a dead pane could still be asserting: a row, or a latch that would re-gate one through
   *  `resolveClaudePaneState` on the pane's next event even after the row reads `done`. The list
   *  itself lives beside `clearPaneCacheState`, so adding a latch cannot leave this behind in a
   *  different file. */
  protected hasLiveClaimsForPaneKey(paneKey: string): boolean {
    return (
      paneHasStateClaims(this.state, paneKey) ||
      this.statusKeysForPaneKey(paneKey).some((statusKey) =>
        paneHasStateClaims(this.state, statusKey)
      )
    )
  }

  /** Clear statuses proven to belong to one lost SSH transport. */
  clearStatusEntriesForConnection(connectionId: string): void {
    const normalizedConnectionId = connectionId.trim()
    if (normalizedConnectionId.length === 0) {
      return
    }
    const clearedAt = Math.max(
      Date.now(),
      (this.connectionTimestampWatermarkById.get(normalizedConnectionId) ?? -1) + 1
    )
    this.connectionTimestampWatermarkById.set(normalizedConnectionId, clearedAt)
    let statusChanged = false
    for (const [statusKey, rawEntry] of this.state.lastStatusByPaneKey) {
      const entry = rawEntry as EnrichedAgentHookEventPayload
      // Why: unstamped rows can't be attributed to one host; leave them for normal pane teardown.
      if (entry.connectionId !== normalizedConnectionId) {
        continue
      }
      const deleted = this.deleteStatusEntryForSubject(entry.subject, { preserveAuthority: true })
      if (deleted) {
        statusChanged = true
        this.commitStatusRowMutation(deleted, undefined)
        if (deleted.payload.agentType === 'codex') {
          // Why: a replacement remote process may reuse the pane; don't merge it with the lost connection's children.
          this.state.codexSubagentRosterByPaneKey.delete(statusKey)
          this.state.codexLeadStateByPaneKey.delete(statusKey)
        } else if (deleted.payload.agentType === 'claude') {
          this.state.claudeSubagentRosterByPaneKey.delete(statusKey)
          this.state.claudeLeadStateByPaneKey.delete(statusKey)
          this.state.claudeRunningNonAgentTaskPaneKeys.delete(statusKey)
          this.state.claudeActiveSessionCronPaneKeys.delete(statusKey)
          this.state.claudeSessionOwnerByPaneKey.delete(statusKey)
        }
      }
    }
    for (const [paneKey, evidence] of this.currentAuthorityObservations) {
      if (evidence.connectionId === normalizedConnectionId) {
        this.currentAuthorityObservations.delete(paneKey)
      }
    }
    if (statusChanged) {
      // Why: persist/notify once — one disconnect can own many panes.
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
    // Why: always send the cutoff even with no matched entry — another host may have overwritten this pane's row.
    this.emitPaneStatusCleared({
      transient: true,
      connectionId: normalizedConnectionId,
      clearedAt
    })
  }

  protected deleteStatusEntry(
    paneKey: string,
    options?: { preserveAuthority?: boolean }
  ): EnrichedAgentHookEventPayload | null {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    const existing = this.latestStatusEntryForPaneKey(resolvedPaneKey)
    return existing ? this.deleteStatusEntryForSubject(existing.subject, options) : null
  }

  protected deleteStatusEntryForSubject(
    subject: AgentStatusSubject,
    options?: { preserveAuthority?: boolean }
  ): EnrichedAgentHookEventPayload | null {
    const statusKey = agentStatusSubjectKey(subject)
    const existing = this.state.lastStatusByPaneKey.get(statusKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!existing) {
      return null
    }
    this.state.lastStatusByPaneKey.delete(statusKey)
    this.activeHookTurnCompletedAtByPaneKey.delete(statusKey)
    if (!options?.preserveAuthority) {
      this.hydratedLaunchTokenHashByPaneKey.delete(statusKey)
      this.persistedAuthorityCommitmentsByPaneKey.delete(statusKey)
    }
    this.clearAssistantMessageRetry(statusKey)
    this.clearCodexSubagentPoll(statusKey)
    this.runtimeObservedStatusPaneKeys.delete(statusKey)
    this.currentAuthorityObservations.delete(statusKey)
    if (existing.payload.state === 'done') {
      this.promptSentDedupeByPaneKey.delete(statusKey)
    }
    return existing
  }
}
