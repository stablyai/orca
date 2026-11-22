import {
  clearPaneCacheState,
  clearPaneStatusCacheState
} from '../../../shared/agent-hook-listener/listener-state'
import { paneCacheKeyMatchesTab } from './server-status-identity'
import { AgentHookServerCleanup, type EndedProcessReconciliationOptions } from './server-cleanup'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { releaseAgentExitKey } from './agent-exit-evidence'
import type { AgentProcessVerdict } from '../../../shared/agent-status/process/agent-process-presence'
import { paneHasStateClaims } from '../../../shared/agent-hook-listener/pane-state-claims'
import type {
  AgentStatusCacheIdentity,
  RefusedPaneResume
} from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { UnprovenAgentExits } from './unproven-agent-exits'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'

export abstract class AgentHookServerTabCleanup extends AgentHookServerCleanup {
  abstract checkAgentPresence(paneKey: string): Promise<AgentProcessVerdict | null>
  protected abstract noticeLaunchlessCommandMark(resolvedPaneKey: string): void
  protected readonly unprovenExits = new UnprovenAgentExits((paneKey) =>
    this.confirmCommandFinishedExit(paneKey)
  )

  retireProcessAuthority(
    paneKey: string,
    options?: Pick<EndedProcessReconciliationOptions, 'confirmedExit'> & { launchRetired?: true }
  ): void {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    if (options?.launchRetired) {
      this.noticeLaunchlessCommandMark(resolved)
      return
    }
    const identity = this.paneAgentIdentity(paneKey)
    const shared = identity?.executionHost === 'shared'
    // A command mark can come from a shell nested in a live agent; one with no process to probe
    // ends only on the host's word that the pane's shell is alone.
    const verifiable = this.hasVerifiableAgentProcess(paneKey)
    const unprovable = identity?.ended === false && !shared && !verifiable
    // A mark's exit status can't tell a quit from a stop (Ctrl-Z). A local process answers through
    // its presence probe, a stopped one included; one the probe can't reach (SSH, WSL) lets the
    // mark stand, as on main.
    const awaitsHost = options?.confirmedExit === true && !verifiable
    const probed = this.state.lastStatusByPaneKey.get(resolved)?.connectionId === null
    const confirmedExit = options?.confirmedExit === true && verifiable && !probed
    const { paneKeys, authorityChanged } = this.revokeProcessAuthority(paneKey)
    const { untouched } = this.reconcileEndedProcess(
      paneKeys,
      { confirmedExit, preserveResumeIdentity: !confirmedExit && !shared },
      (key) => this.clearRevokedPaneState(key)
    )
    // A stopped agent (Ctrl-Z) refuses the proof, and a later mark proves its quit.
    this.unprovenExits.launchRetired(resolved, unprovable && awaitsHost, awaitsHost)
    for (const key of untouched) {
      this.clearTmuxInnerSubjects(key)
      this.clearPaneProcessState(key)
    }
    if (authorityChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
  }

  private async confirmCommandFinishedExit(resolved: string): Promise<boolean> {
    const row = this.state.lastStatusByPaneKey.get(resolved)
    const identity = this.paneAgentIdentity(resolved)
    const agent = identity?.status.agentType
    const alone = await this.terminalPaneLifecycle?.confirmShellAlone?.(resolved, agent)
    // A newer row may be the same conversation's; only a later proof can settle it.
    if (this.state.lastStatusByPaneKey.get(resolved) !== row) {
      return false
    }
    if (alone === false) {
      return false
    }
    this.reconcileEndedProcessForPaneKeys([resolved], {
      preserveResumeIdentity: true,
      confirmedExit: alone === true ? 'proven' : true,
      known: { paneKey: resolved, identity }
    })
    return true
  }

  hasVerifiableAgentProcess(paneKey: string): boolean {
    const presence = this.state.lastStatusByPaneKey.get(
      this.resolvePaneKeyAlias(paneKey)
    )?.agentPresence
    return presence?.process !== undefined && !presence.ended
  }

  /** Shells without command marks need the owning host's process-tree proof. */
  async reconcilePaneProcessExit(paneKey: string): Promise<void> {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    // A verifiable process answers for itself (exited, stopped or live); the quiet shell proves
    // nothing. A command mark's proof owns a tracked pane; reconciling here would forget it.
    const tracked = this.unprovenExits.has(resolved)
    if (tracked || this.hasVerifiableAgentProcess(resolved)) {
      await (tracked ? this.unprovenExits.settled(resolved) : this.checkAgentPresence(resolved))
      return
    }
    const row = this.state.lastStatusByPaneKey.get(resolved)
    const identity = this.paneAgentIdentity(resolved)
    const agent = identity?.status.agentType
    // An ended agent needs no proof.
    const confirmedExit =
      identity?.ended === false &&
      identity.executionHost !== 'shared' &&
      agent &&
      (await this.terminalPaneLifecycle?.confirmProcessExit?.(resolved, agent))
    if (this.state.lastStatusByPaneKey.get(resolved) !== row) {
      return
    }
    this.reconcileEndedProcessForPaneKeys([resolved], {
      preserveResumeIdentity: true,
      confirmedExit: confirmedExit === true,
      known: { paneKey: resolved, identity }
    })
  }

  dropPersistedStatusEntry(identity: AgentStatusCacheIdentity): boolean {
    return this.dropPersistedStatusEntries([identity]).length > 0
  }

  reconcileEndedProcessForPaneKeys(
    paneKeys: Iterable<string>,
    options?: EndedProcessReconciliationOptions
  ): number {
    return this.reconcileEndedProcess(paneKeys, options, (key) =>
      this.clearPaneState(key, { emitStatusRowMutation: false })
    ).cleared
  }

  /** Include latches that can revive work even when the visible row is done. */
  protected hasLiveClaimsForPaneKey(paneKey: string): boolean {
    return Boolean(this.getTmuxSelectedStatus(paneKey)) || paneHasStateClaims(this.state, paneKey)
  }

  /** The host refused `paneKey`'s saved resume because a native chat is its conversation's home:
   *  forget the pane's claim here, with no resumable remnant, and tell renderers to forget theirs. */
  forgetRefusedPaneResume(paneKey: string, refused: RefusedPaneResume): void {
    // A moved pane's row, and the renderer's state for it, live under its owner's key.
    const ownerKey = this.resolvePaneKeyAlias(paneKey)
    const row = this.state.lastStatusByPaneKey.get(ownerKey)
    const clear = { paneKey: ownerKey, refusedResume: refused }
    if (
      row &&
      'receivedAt' in row &&
      typeof row.receivedAt === 'number' &&
      'stateStartedAt' in row &&
      typeof row.stateStartedAt === 'number' &&
      refused.expectedStatus &&
      row.receivedAt <= refused.expectedStatus.receivedAt &&
      row.stateStartedAt === refused.expectedStatus.stateStartedAt &&
      row.payload.agentType === refused.agent &&
      agentProviderSessionsEqual(refused.agent, row.providerSession, refused.providerSession)
    ) {
      this.dropStatusEntry(ownerKey, { preserveResumeIdentity: false })
      this.emitPaneStatusCleared(clear)
      return
    }
    // Renderers only: the pane's row is another conversation's, which other subscribers keep.
    this.onPaneStatusCleared?.(clear)
  }

  /** Drop every status/cache claim attributable to a closed tab prefix. */
  dropStatusEntriesByTabPrefix(tabId: string): void {
    this.markTabClosedForAgentStatus(tabId)
    this.clearTmuxTabSubjects(tabId)
    this.unprovenExits.forgetWhere((key) => paneCacheKeyMatchesTab(key, tabId))
    const paneKeysToClear = new Set<string>()
    const statusPaneKeysToClear = new Set<string>()
    const statusRowsToClear: EnrichedAgentHookEventPayload[] = []
    for (const key of this.state.lastStatusByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key)
        statusPaneKeysToClear.add(key)
        const row = this.state.lastStatusByPaneKey.get(key) as
          | EnrichedAgentHookEventPayload
          | undefined
        if (row) {
          statusRowsToClear.push(row)
        }
      }
    }
    for (const key of this.state.lastPromptByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this.state.lastToolByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of [
      ...this.state.antigravityCompletedTranscriptByPaneKey.keys(),
      ...this.state.antigravityChildWorkByPaneKey.keys()
    ]) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const key of this.state.ampCompletedCacheKeys) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        paneKeysToClear.add(key.split('\0', 1)[0] ?? key)
      }
    }
    for (const paneKey of this.runtimeObservedStatusPaneKeys) {
      if (paneCacheKeyMatchesTab(paneKey, tabId)) {
        paneKeysToClear.add(paneKey)
      }
    }
    for (const paneKey of this.promptSentDedupeByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(paneKey, tabId)) {
        paneKeysToClear.add(paneKey)
      }
    }
    for (const commitment of this.hydratedAuthorityCommitments) {
      if (paneCacheKeyMatchesTab(commitment.paneKey, tabId)) {
        paneKeysToClear.add(commitment.paneKey)
      }
    }
    let aliasChanged = false
    for (const [legacyPaneKey, entry] of this.legacyPaneKeyAliases) {
      if (paneCacheKeyMatchesTab(entry.stablePaneKey, tabId)) {
        this.legacyPaneKeyAliases.delete(legacyPaneKey)
        paneKeysToClear.add(legacyPaneKey)
        paneKeysToClear.add(entry.stablePaneKey)
        this.markPaneClosedForAgentStatus(legacyPaneKey)
        this.markPaneClosedForAgentStatus(entry.stablePaneKey)
        aliasChanged = true
      }
    }
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeysToClear)
    let statusChanged = false
    for (const paneKey of paneKeysToClear) {
      if (this.state.lastStatusByPaneKey.has(paneKey)) {
        statusChanged = true
      }
      this.clearAssistantMessageRetry(paneKey)
      this.clearTranscriptPoll(paneKey)
      clearPaneCacheState(this.state, paneKey)
      this.activeHookTurnCompletedAtByPaneKey.delete(paneKey)
      this.runtimeObservedStatusPaneKeys.delete(paneKey)
      this.currentAuthorityObservations.delete(paneKey)
      this.promptSentDedupeByPaneKey.delete(paneKey)
      this.restartedStatusLaunchTokenHashByPaneKey.delete(paneKey)
      this.evidenceObservedAtByPaneKey.delete(paneKey)
      this.programStatusFacets.delete(paneKey)
      this.hookSilenceRechecks.cancel(paneKey)
      this.programStatusFacetRepublishes.cancel(paneKey)
    }
    // Exits outlive their rows; match tab identity independently of cleared status keys.
    let exitsChanged = false
    for (const key of this.agentExitedAtByPaneKey.keys()) {
      if (paneCacheKeyMatchesTab(key, tabId)) {
        exitsChanged = releaseAgentExitKey(this.agentExitedAtByPaneKey, key) || exitsChanged
      }
    }
    if (aliasChanged) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    for (const row of statusRowsToClear) {
      this.commitStatusRowMutation(row, undefined)
    }
    if (statusChanged || authorityChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    } else if (exitsChanged) {
      this.scheduleStatusPersist()
    }
    // Subscribers must release pane-scoped state when the tab closes.
    for (const paneKey of statusPaneKeysToClear) {
      this.emitPaneStatusCleared({ paneKey })
    }
  }

  clearPaneState(
    paneKey: string,
    options?: {
      emitStatusRowMutation?: boolean
      preserveTmuxInnerSubjects?: boolean
      statusUnavailable?: true
      /** The pane's PTY is retired, not just its agent. */
      forgetAgentExit?: true
    }
  ): void {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    this.unprovenExits.forget(resolvedPaneKey)
    if (options?.forgetAgentExit) {
      this.forgetAgentExit(paneKey)
    }
    if (!options?.preserveTmuxInnerSubjects) {
      this.clearTmuxInnerSubjects(resolvedPaneKey)
    }
    const paneKeys = new Set([paneKey, resolvedPaneKey])
    // Why: only persist when a status entry was actually evicted; dropping prompt/tool caches doesn't change the file.
    const previousStatus = this.state.lastStatusByPaneKey.get(resolvedPaneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const hadStatus = previousStatus !== undefined
    this.clearPaneProcessState(resolvedPaneKey)
    clearPaneStatusCacheState(this.state, resolvedPaneKey)
    let clearedAlias = false
    for (const [legacyPaneKey, alias] of this.legacyPaneKeyAliases) {
      if (alias.stablePaneKey === resolvedPaneKey) {
        this.legacyPaneKeyAliases.delete(legacyPaneKey)
        paneKeys.add(legacyPaneKey)
        paneKeys.add(alias.stablePaneKey)
        this.clearPaneProcessState(legacyPaneKey)
        clearPaneStatusCacheState(this.state, legacyPaneKey)
        clearedAlias = true
      }
    }
    const authorityChanged = this.revokeHydratedAuthorityForPaneKeys(paneKeys)
    if (clearedAlias) {
      this.notifyPaneKeyAliasPersistenceListener()
    }
    if (options?.emitStatusRowMutation !== false) {
      this.commitStatusRowMutation(previousStatus, undefined)
    }
    if (hadStatus || authorityChanged) {
      this.runtimeObservedStatusPaneKeys.delete(resolvedPaneKey)
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
      this.emitPaneStatusCleared({
        paneKey: resolvedPaneKey,
        statusUnavailable: options?.statusUnavailable
      })
    }
  }
}
