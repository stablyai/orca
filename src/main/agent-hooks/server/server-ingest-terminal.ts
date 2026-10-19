import { track } from '../../telemetry/client'
import { MAX_PANE_KEY_LEN } from '../../../shared/agent-hook-listener/listener-limits'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { terminalStatusPayloadMatchesHook } from '../../../shared/agent-terminal-status-equivalence'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { agentSubagentsEqual } from '../../../shared/agent-status-subagent-snapshot'
import { isAgentStatusHeldOpenByChildWork } from '../../../shared/agent-lead-status-fold'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'
import {
  HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS,
  programStatusYieldsToHookRow
} from './program-status/hook-precedence'
import type { ProgramStatusFacet } from '../../../shared/program-status/facet'

const PROGRAM_STATUS_FACET_REPUBLISH_MS = 250

export abstract class AgentHookServerIngestTerminal extends AgentHookServerIngestNormalization {
  /**
   * A resume launch names its provider session before the agent reports one. Codex runs
   * SessionStart only at its first turn, so until the user typed, readers had no transcript
   * to address and native chat stayed empty (#10923). Seeds an identity-only row.
   */
  recordLaunchResumeIdentity(event: {
    paneKey: string
    worktreeId?: string
    agentType: string
    providerSession: AgentProviderSessionMetadata
    /** When the pane's process launched; a row reported since then is the agent's own. */
    launchedAt: number
  }): void {
    const paneKey = this.resolvePaneKeyAlias(event.paneKey.trim())
    const parsedPaneKey = parsePaneKey(paneKey)
    if (!parsedPaneKey || paneKey.length > MAX_PANE_KEY_LEN) {
      return
    }
    const previous = this.state.lastStatusByPaneKey.get(paneKey)
    if (
      previous &&
      (previous.providerSessionOnly === true
        ? agentProviderSessionsEqual(
            event.agentType,
            previous.providerSession,
            event.providerSession
          )
        : 'receivedAt' in previous &&
          typeof previous.receivedAt === 'number' &&
          previous.receivedAt >= event.launchedAt)
    ) {
      return
    }
    const identity: AgentHookEventPayload &
      Pick<EnrichedAgentHookEventPayload, 'retainedForLiveness'> = {
      paneKey,
      tabId: parsedPaneKey.tabId,
      ...(event.worktreeId?.trim() ? { worktreeId: event.worktreeId.trim() } : {}),
      connectionId: null,
      providerSession: event.providerSession,
      providerSessionOnly: true,
      // Why: hydration keeps only marked identity rows; a host restart before the first turn must not lose it.
      retainedForLiveness: true,
      payload: { state: 'done', prompt: '', agentType: event.agentType }
    }
    this.applyNormalizedStatus(identity, undefined, 'launch')
  }

  /** The pane's OSC 7501 facet changed. Applies whoever owns the row's state; see ProgramStatusFacetStore. */
  ingestProgramStatusFacet(event: { paneKey: string; facet: ProgramStatusFacet | null }): void {
    const paneKey = this.resolvePaneKeyAlias(event.paneKey.trim())
    if (
      paneKey.length > MAX_PANE_KEY_LEN ||
      (!parsePaneKey(paneKey) && !parseLegacyNumericPaneKey(paneKey))
    ) {
      return
    }
    const before = this.programStatusFacets.get(paneKey)
    if (!this.programStatusFacets.set(paneKey, event.facet)) {
      return
    }
    if (before !== undefined && event.facet !== null && before.state === event.facet.state) {
      this.programStatusFacetRepublishes.deferUnlessPending(
        paneKey,
        PROGRAM_STATUS_FACET_REPUBLISH_MS,
        (currentPaneKey) => this.republishProgramStatusFacet(currentPaneKey)
      )
      return
    }
    this.programStatusFacetRepublishes.cancel(paneKey)
    this.republishProgramStatusFacet(paneKey)
  }

  ingestTerminalStatus(event: {
    ptyId?: string
    paneKey: string
    tabId?: string
    worktreeId?: string
    connectionId?: string | null
    terminalHandle?: string
    payload: ParsedAgentStatusPayload
    /** `process`: derived from the pane's foreground process rather than parsed from its bytes. */
    origin?: 'process'
    /** Drop this write when a hook has reported the pane since then (the hook owns that command). */
    yieldsToHookSince?: number
    /** Projected from OSC 7501: yields to the pane's hook row (programStatusYieldsToHookRow). */
    fromProgramStatus?: true
    /** The program left no records: a row only OSC wrote is removed instead. */
    removesProgramStatusRow?: true
    /** A repeat that renews a live program row's freshness; the window must see it too. */
    renewsProgramStatusLease?: true
  }): void {
    const physicalPaneKey = event.paneKey.trim()
    let paneKey = this.resolvePaneKeyAlias(physicalPaneKey)
    const parsedPaneKey = parsePaneKey(paneKey)
    const legacyPaneKey = parseLegacyNumericPaneKey(paneKey)
    if (paneKey.length === 0) {
      track('agent_hook_unattributed', { reason: 'empty_pane_key' })
      return
    }
    const reportedTabId =
      event.tabId !== undefined && event.tabId.trim().length > 0 ? event.tabId.trim() : undefined
    const runtimeOwnedLegacyPane = Boolean(
      legacyPaneKey &&
      event.ptyId?.trim() &&
      event.terminalHandle?.trim() &&
      reportedTabId === legacyPaneKey.tabId
    )
    // Legacy rows are accepted only from the in-process PTY ingress with both runtime identities;
    // HTTP and relay paths still require a stable pane key or a registered alias.
    if (paneKey.length > MAX_PANE_KEY_LEN || (!parsedPaneKey && !runtimeOwnedLegacyPane)) {
      return
    }
    const paneTabId = parsedPaneKey?.tabId ?? legacyPaneKey?.tabId
    if (paneKey === physicalPaneKey && reportedTabId !== undefined && reportedTabId !== paneTabId) {
      return
    }
    const tabId = paneKey !== physicalPaneKey ? parsedPaneKey?.tabId : reportedTabId
    const worktreeId = event.worktreeId?.trim() || undefined
    const connectionId =
      typeof event.connectionId === 'string' && event.connectionId.trim().length > 0
        ? event.connectionId.trim()
        : null
    const retainedLaunchTokenHash = this.retainedOwnerLaunchTokenHash(paneKey, {
      worktreeId,
      connectionId
    })
    const newRun = event.origin === 'process' && event.payload.state === 'working'
    // Why: a verified process-lifetime Working proves a new agent run, as a hook new-turn event does.
    const disposition = this.getAgentStatusDisposition(
      paneKey,
      newRun
        ? { processNewTurn: true }
        : this.restartedStatusLaunchTokenHashByPaneKey.get(paneKey)?.allowRetainedOwner
          ? { retainedLaunchTokenHash }
          : undefined
    )
    if (disposition === 'suppress') {
      return
    }
    if (event.origin === 'process' && event.payload.state === 'working') {
      this.forgetAgentExit(paneKey)
    }
    if (disposition === 'restart') {
      this.observations.rebind(paneKey)
    }
    const terminalHandle =
      typeof event.terminalHandle === 'string' && event.terminalHandle.trim().length > 0
        ? event.terminalHandle.trim()
        : undefined
    let mutationBefore: EnrichedAgentHookEventPayload | undefined
    const indexedPaneKey = terminalHandle
      ? this.getStatusPaneKeyForTerminalHandle(terminalHandle)
      : undefined
    if (indexedPaneKey && indexedPaneKey !== paneKey) {
      const indexedStatus = this.state.lastStatusByPaneKey.get(indexedPaneKey) as
        | EnrichedAgentHookEventPayload
        | undefined
      if (
        indexedStatus &&
        indexedStatus.terminalHandle === terminalHandle &&
        this.sameTerminalOwner(indexedStatus, { connectionId, worktreeId })
      ) {
        mutationBefore = indexedStatus
        this.transferPaneAuthority(indexedPaneKey, paneKey, event.ptyId, Date.now(), {
          authorityVerified: true,
          emitStatusRowMutation: false
        })
        paneKey = this.resolvePaneKeyAlias(paneKey)
      }
    }
    const previous = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    // Why: a hook that reported during this command owns it (OpenCode 1 `run` loads its plugin in-process).
    const hookOwnsCommand =
      event.yieldsToHookSince !== undefined &&
      previous?.observation?.origin === 'hook' &&
      previous.receivedAt >= event.yieldsToHookSince
    if (event.removesProgramStatusRow === true) {
      // Why: gone records end only the program's own row; they are no verdict on a hook agent.
      this.hookSilenceRechecks.cancel(paneKey)
      if (previous?.observation?.origin === 'osc') {
        // Why a row drop, not pane teardown: the process lives on, and so do its alias and caches.
        if (mutationBefore !== undefined) {
          this.commitStatusRowMutation(mutationBefore, previous)
        }
        this.dropStatusEntry(paneKey)
        this.emitPaneStatusCleared({ paneKey, programStatusRemoved: true })
      }
      return
    }
    const hookOwnsAgent =
      event.fromProgramStatus === true &&
      programStatusYieldsToHookRow(previous, event.payload, Date.now())
    if (event.fromProgramStatus === true) {
      if (hookOwnsAgent && previous && event.payload.state !== previous.payload.state) {
        const yieldedTo = previous.receivedAt
        const delayMs = yieldedTo + HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS - Date.now()
        this.hookSilenceRechecks.defer(paneKey, delayMs + 1, (currentPaneKey) => {
          const row = this.state.lastStatusByPaneKey.get(currentPaneKey)
          // Only against the hook observation it yielded to: a newer turn or a cleared pane drops it.
          if (
            row &&
            row.providerSessionOnly !== true &&
            'receivedAt' in row &&
            row.receivedAt === yieldedTo
          ) {
            const tabId = parsePaneKey(currentPaneKey)?.tabId ?? event.tabId
            this.ingestTerminalStatus({ ...event, paneKey: currentPaneKey, tabId })
          }
        })
      } else {
        this.hookSilenceRechecks.cancel(paneKey)
      }
    }
    if (
      hookOwnsCommand ||
      hookOwnsAgent ||
      // OSC 7501 settles child-held rows through its own hook precedence above.
      (event.fromProgramStatus !== true &&
        previous?.payload.agentType === 'claude' &&
        event.payload.agentType === 'claude' &&
        isAgentStatusHeldOpenByChildWork(previous.payload) &&
        previous.payload.subagents?.some((subagent) => subagent.state === 'working') === true)
    ) {
      // Why: OSC carries no child identity, so it cannot settle or repaint a row child agents hold open
      // (working, or waiting on a child's prompt); their lifecycle hooks will.
      if (previous && mutationBefore !== undefined) {
        this.commitStatusRowMutation(mutationBefore, previous)
        this.emitEnrichedStatus(previous)
      }
      return
    }
    // Why: preserve the hook-completed turn stamp while OSC repaints the current state.
    const preserveActiveTurnStamp =
      previous?.payload.turnCompletedAt !== undefined &&
      previous.payload.turnCompletedAt === this.activeHookTurnCompletedAtByPaneKey.get(paneKey)
    if (
      !previous?.restoredUnconfirmed &&
      previous?.connectionId === connectionId &&
      previous.tabId === tabId &&
      previous.worktreeId === worktreeId &&
      // Why in the unchanged gate: the handle is a join key readers match on, so a pane that
      // only just acquired one (or moved to another) must still refresh the row it is stamped on.
      previous.terminalHandle === (terminalHandle ?? previous.terminalHandle) &&
      terminalStatusPayloadMatchesHook(previous.payload, event.payload, preserveActiveTurnStamp) &&
      // OSC 7501 does carry children, so a child-only change is news (absent means none left).
      (event.fromProgramStatus !== true ||
        agentSubagentsEqual(previous.payload.subagents, event.payload.subagents))
    ) {
      // A handle-authority transfer is a new pane observation even when its payload is a
      // duplicate; enriched subscribers must capture the replacement pane identity.
      this.refreshTerminalStatusEvidence(
        previous,
        mutationBefore,
        mutationBefore !== undefined || event.renewsProgramStatusLease === true,
        newRun
      )
      return
    }
    // Why: the OSC 9999 wire payload has no providerSession field at all, so an OSC observation is
    // never evidence that the session ended — yet overwriting the row dropped the cached identity.
    // That erased it from persisted rows (lost across restart) and from headless `orca serve`, which
    // serves these rows to mobile directly instead of the renderer store, blanking Chat UI (#10630).
    // A new turn after `done` still starts clean so a reused pane cannot inherit a finished session.
    // Why: mirror resolveAgentStatusIdentity, which treats a literal 'unknown' exactly like an
    // omitted type — an OSC ping that names no agent makes no claim about the pane's identity, so
    // it must not be read as a mismatch and strip the session the renderer would have kept.
    const claimedAgentType =
      event.payload.agentType && event.payload.agentType !== 'unknown'
        ? event.payload.agentType
        : undefined
    // A launch seed's `done` is a placeholder, not a finished turn, so its session carries over.
    const preservedProviderSession =
      previous?.providerSession &&
      (claimedAgentType === undefined || claimedAgentType === previous.payload.agentType) &&
      (previous.payload.state !== 'done' ||
        event.payload.state === 'done' ||
        previous.observation?.origin === 'launch')
        ? previous.providerSession
        : undefined
    // Why: OSC carries no main agent fact. While it repaints the state the hook row already holds, the
    // main agent behind that state is unchanged too; a different state is a turn edge OSC cannot date.
    const preservedMainAgent =
      event.payload.mainAgent ??
      (previous?.payload.mainAgent &&
      previous.payload.state === event.payload.state &&
      (claimedAgentType === undefined || claimedAgentType === previous.payload.agentType)
        ? previous.payload.mainAgent
        : undefined)
    // Why: OSC status is a runtime observation, not a prompt boundary; keep prompt-sent telemetry tied to native hooks.
    this.applyNormalizedStatus(
      {
        paneKey,
        tabId,
        worktreeId,
        connectionId,
        ...(preservedProviderSession ? { providerSession: preservedProviderSession } : {}),
        ...(terminalHandle ? { terminalHandle } : {}),
        payload: preservedMainAgent
          ? { ...event.payload, mainAgent: preservedMainAgent }
          : event.payload
      },
      undefined,
      event.origin ?? 'osc',
      undefined,
      mutationBefore,
      newRun
    )
  }
}
