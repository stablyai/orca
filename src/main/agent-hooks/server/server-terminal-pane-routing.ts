import {
  clearPaneCacheState,
  paneHasStateClaims
} from '../../../shared/agent-hook-listener/listener-state'
import { isWslHookRelayConnectionId } from '../../../shared/wsl-hook-relay-contract'
import { AgentHookServerAuthorityFences } from './server-authority-fences'
import { isValidPaneKey } from './server-status-identity'
import type { EnrichedAgentHookEventPayload } from './server-types'

export type TerminalPaneMove = {
  fromPaneKey: string
  toPaneKey: string
  /** The host that runs the terminal; rows from any other host are never moved. */
  connectionId: string | null
  /** Follows an alias this terminal's own pane move minted, and no other. */
  ptyId: string
}

/** A WSL relay id is transport provenance; the terminal it names is local. */
export function executionHostConnectionId(connectionId: string | null | undefined): string | null {
  return isWslHookRelayConnectionId(connectionId) ? null : (connectionId ?? null)
}

/** Moves state filed under a terminal's exported pane key to the pane it shows now; no alias is minted. */
export abstract class AgentHookServerTerminalPaneRouting extends AgentHookServerAuthorityFences {
  setTerminalPaneResolver(
    resolver: ((paneKey: string, connectionId?: string | null) => string | undefined) | null
  ): void {
    this.terminalPaneResolver = resolver
  }

  reconcileMovedTerminalPaneKeys(moves: readonly TerminalPaneMove[]): void {
    for (const move of moves) {
      const { toPaneKey, connectionId } = move
      const fromPaneKey = this.followOwnAlias(move)
      const fromRow = this.statusRow(fromPaneKey)
      if (
        fromPaneKey === toPaneKey ||
        !isValidPaneKey(fromPaneKey) ||
        !isValidPaneKey(toPaneKey) ||
        !this.holdsPaneAuthorityState(fromPaneKey) ||
        (fromRow !== undefined &&
          executionHostConnectionId(fromRow.connectionId) !== connectionId) ||
        this.isClosedAgentStatusTabForPaneKey(toPaneKey)
      ) {
        continue
      }
      const toRow = this.statusRow(toPaneKey)
      // Before any mutation: a rejected move must leave aliases and fences exactly as they were.
      if (toRow && executionHostConnectionId(toRow.connectionId) !== connectionId) {
        continue
      }
      this.takeRetiredPaneRestartId(fromPaneKey)
      this.takeRetiredPaneRestartId(toPaneKey)
      this.repointPaneKeyAliases(fromPaneKey, toPaneKey)
      // Why evidence age: a spool replay is stamped with a fresh receivedAt for old evidence.
      if (toRow && (!fromRow || evidenceAge(fromRow) <= evidenceAge(toRow))) {
        // The pane's own row wins, so its launch authority stays as is.
        this.clearRawPaneState(fromPaneKey)
        continue
      }
      if (toRow) {
        // The exported key's row is newer: the pane's own older state yields to it entirely.
        this.clearRawPaneState(toPaneKey)
      }
      this.commitMovedPaneAuthorityState(this.movePaneAuthorityState(fromPaneKey, toPaneKey), true)
    }
  }

  // Why: a pane detach aliased the exported key to the pane it moved to, so the state lives there.
  private followOwnAlias(move: TerminalPaneMove): string {
    const alias = this.legacyPaneKeyAliases.get(move.fromPaneKey)
    if (!alias || alias.ptyId !== move.ptyId || alias.stablePaneKey === move.toPaneKey) {
      return move.fromPaneKey
    }
    return alias.stablePaneKey
  }

  private repointPaneKeyAliases(fromPaneKey: string, toPaneKey: string): void {
    let changed = false
    for (const [physicalPaneKey, entry] of this.legacyPaneKeyAliases) {
      if (entry.stablePaneKey === fromPaneKey) {
        this.legacyPaneKeyAliases.set(physicalPaneKey, { ...entry, stablePaneKey: toPaneKey })
        changed = true
      }
    }
    if (changed) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
  }

  // Raw key, never through an alias: an alias owner is a different pane.
  private clearRawPaneState(paneKey: string): void {
    const row = this.statusRow(paneKey)
    this.hydratedLaunchTokenHashByPaneKey.delete(paneKey)
    this.persistedAuthorityCommitmentsByPaneKey.delete(paneKey)
    this.restartedStatusLaunchTokenHashByPaneKey.delete(paneKey)
    this.clearAssistantMessageRetry(paneKey)
    this.clearTranscriptPoll(paneKey)
    clearPaneCacheState(this.state, paneKey)
    this.activeHookTurnCompletedAtByPaneKey.delete(paneKey)
    this.runtimeObservedStatusPaneKeys.delete(paneKey)
    this.currentAuthorityObservations.delete(paneKey)
    this.promptSentDedupeByPaneKey.delete(paneKey)
    this.evidenceObservedAtByPaneKey.delete(paneKey)
    if (row) {
      this.commitStatusRowMutation(row, undefined)
      this.emitPaneStatusCleared({ paneKey })
    }
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
  }

  private statusRow(paneKey: string): EnrichedAgentHookEventPayload | undefined {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every row in this store is written through applyNormalizedStatus or hydration, which stamp the enriched fields.
    return this.state.lastStatusByPaneKey.get(paneKey) as EnrichedAgentHookEventPayload | undefined
  }

  private holdsPaneAuthorityState(paneKey: string): boolean {
    return (
      paneHasStateClaims(this.state, paneKey) ||
      this.hydratedLaunchTokenHashByPaneKey.has(paneKey) ||
      this.persistedAuthorityCommitmentsByPaneKey.has(paneKey) ||
      this.currentAuthorityObservations.has(paneKey) ||
      this.restartedStatusLaunchTokenHashByPaneKey.has(paneKey)
    )
  }
}

function evidenceAge(row: EnrichedAgentHookEventPayload): number {
  return row.evidenceObservedAt ?? row.receivedAt
}
