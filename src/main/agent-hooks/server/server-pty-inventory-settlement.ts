import { AgentHookServerTabCleanup } from './server-tab-cleanup'
import type { EnrichedAgentHookEventPayload } from './server-types'

/**
 * A row a host-scoped PTY inventory is allowed to adjudicate, with the identity that makes an
 * asynchronous verdict safe to act on.
 *
 * `receivedAt` + `stateStartedAt` pin the exact event instance, the same pair
 * `dropPersistedStatusEntries` uses to evict only what it actually read.
 */
export type AgentStatusPtyInventoryCandidate = Readonly<{
  paneKey: string
  /** SSH connection the row's evidence arrived on, or null for local. */
  connectionId: string | null
  /** Workspace the row claims, so its declared execution host can be checked against the inventory. */
  worktreeId?: string
  receivedAt: number
  stateStartedAt: number
}>

export abstract class AgentHookServerPtyInventorySettlement extends AgentHookServerTabCleanup {
  /**
   * Rows whose "this agent is still working" claim only a PTY could retire.
   *
   * A PTY that dies while Orca is down never runs the teardown that clears pane state, so hydrate
   * rebuilds rows and latches that no later hook can retire: the pane gates `working` for the rest
   * of its life. The host-scoped PTY inventory is the one thing that re-derives the truth behind
   * that latch, so it gets the candidates and settles them — for every agent and every host, not
   * just the one vendor a startup sweep used to cover.
   *
   * Fence: a pane that has produced status in THIS runtime is never offered. It has a live
   * producer, and an inventory must not adjudicate a conversation it is not part of.
   */
  listPtyInventorySettlementCandidates(): AgentStatusPtyInventoryCandidate[] {
    const candidates: AgentStatusPtyInventoryCandidate[] = []
    for (const [paneKey, raw] of this.state.lastStatusByPaneKey) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main admits enriched legacy rows into this map; the shared state declares the base event type.
      const entry = raw as EnrichedAgentHookEventPayload
      if (
        // A structured session has no PTY, so no inventory can speak for it; its host owns the row.
        entry.structuredHost ||
        // An identity-only remnant carries no state claim, so there is nothing here to retire.
        entry.providerSessionOnly ||
        this.runtimeObservedStatusPaneKeys.has(paneKey) ||
        !this.hasLiveClaimsForPaneKey(paneKey)
      ) {
        continue
      }
      candidates.push({
        paneKey,
        connectionId: entry.connectionId ?? null,
        ...(entry.worktreeId ? { worktreeId: entry.worktreeId } : {}),
        receivedAt: entry.receivedAt,
        stateStartedAt: entry.stateStartedAt
      })
    }
    return candidates
  }

  /**
   * Retire the rows whose PTY the owning host proved absent.
   *
   * Re-checks both fences the listing above cannot hold across the caller's asynchronous verdict:
   * a producer may have spoken for the pane while the host was being asked, and a newer event may
   * have replaced the very row the verdict was about. Either one abandons the settle for that pane
   * — the next inventory pass re-derives it.
   *
   * Resume identity survives. The pane itself outlived this PTY (that is the whole case: a restart
   * its process did not survive), so the `providerSessionOnly` remnant is still resumable in place.
   * It carries no state claim and therefore cannot gate the pane `working` again.
   */
  settlePtyInventoryAbsence(settled: Iterable<AgentStatusPtyInventoryCandidate>): number {
    let cleared = 0
    for (const candidate of settled) {
      const paneKey = this.resolvePaneKeyAlias(candidate.paneKey)
      // Defence in depth rather than an independent gate: every candidate is a hydrated row, and
      // an accepted live event for one restamps `receivedAt` strictly past its restored-status
      // watermark, so the identity check below already refuses these. Kept because a producer that
      // claimed the pane is the store's own reason to refuse, independent of how the row moved.
      if (this.runtimeObservedStatusPaneKeys.has(paneKey)) {
        continue
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main admits enriched legacy rows into this map; the shared state declares the base event type.
      const current = this.state.lastStatusByPaneKey.get(paneKey) as
        | EnrichedAgentHookEventPayload
        | undefined
      if (
        !current ||
        current.stateStartedAt !== candidate.stateStartedAt ||
        current.receivedAt > candidate.receivedAt
      ) {
        continue
      }
      cleared += this.reconcileEndedProcessForPaneKeys([paneKey], {
        preserveResumeIdentity: true
      })
    }
    return cleared
  }
}
