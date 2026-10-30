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
import { programStatusHookYieldEndsAt } from './program-status/hook-precedence'
import type { ProgramStatusFacet } from '../../../shared/program-status/facet'

const PROGRAM_STATUS_FACET_REPUBLISH_MS = 250

export abstract class AgentHookServerIngestTerminal extends AgentHookServerIngestNormalization {
  /** Seed resume identity before the first hook; Codex SessionStart waits for the first turn (#10923). */
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
      // Hydration must retain this identity even if no first turn occurs before restart.
      retainedForLiveness: true,
      payload: { state: 'done', prompt: '', agentType: event.agentType }
    }
    this.applyNormalizedStatus(identity, undefined, 'launch')
  }

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
    /** Projected from OSC 7501: yields to the pane's hook row (programStatusHookYieldEndsAt). */
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
    // Only PTY ingress can admit legacy keys with runtime identities; HTTP and relay require stable keys or aliases.
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
    // Process-lifetime working proves a new run, like a hook turn boundary.
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
    // OpenCode 1 run loads hooks in-process; a hook during the command owns its status.
    const hookOwnsCommand =
      event.yieldsToHookSince !== undefined &&
      previous?.observation?.origin === 'hook' &&
      previous.receivedAt >= event.yieldsToHookSince
    const now = Date.now()
    // Record ordering before removal, which also marks a program turn boundary.
    const workingSince =
      event.fromProgramStatus === true
        ? this.programStatusFacets.noteState(paneKey, event.payload.state, now)
        : undefined
    if (event.removesProgramStatusRow === true) {
      this.hookSilenceRechecks.cancel(paneKey)
      if (previous?.observation?.origin === 'osc') {
        // The program row ended; the pane, aliases and caches remain live.
        if (mutationBefore !== undefined) {
          this.commitStatusRowMutation(mutationBefore, previous)
        }
        this.dropStatusEntry(paneKey)
        this.emitPaneStatusCleared({ paneKey, programStatusRemoved: true })
      }
      return
    }
    const yieldEndsAt =
      event.fromProgramStatus === true
        ? programStatusHookYieldEndsAt(previous, event.payload, workingSince)
        : undefined
    const hookOwnsAgent = yieldEndsAt !== undefined && now < yieldEndsAt
    if (event.fromProgramStatus === true) {
      if (hookOwnsAgent && previous && Number.isFinite(yieldEndsAt)) {
        const yieldedTo = previous.receivedAt
        const delayMs = yieldEndsAt - now
        this.hookSilenceRechecks.defer(paneKey, delayMs + 1, (currentPaneKey) => {
          const row = this.state.lastStatusByPaneKey.get(currentPaneKey)
          // Re-offer only against the hook observation this report yielded to.
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
      // OSC 7501 uses the hook precedence above; other terminal reports cannot settle child-held work.
      (event.fromProgramStatus !== true &&
        previous?.payload.agentType === 'claude' &&
        event.payload.agentType === 'claude' &&
        isAgentStatusHeldOpenByChildWork(previous.payload) &&
        previous.payload.subagents?.some((subagent) => subagent.state === 'working') === true)
    ) {
      if (previous && mutationBefore !== undefined) {
        this.commitStatusRowMutation(mutationBefore, previous)
        this.emitEnrichedStatus(previous)
      }
      return
    }
    const preserveActiveTurnStamp =
      previous?.payload.turnCompletedAt !== undefined &&
      previous.payload.turnCompletedAt === this.activeHookTurnCompletedAtByPaneKey.get(paneKey)
    if (
      !previous?.restoredUnconfirmed &&
      previous?.connectionId === connectionId &&
      previous.tabId === tabId &&
      previous.worktreeId === worktreeId &&
      // A terminal handle joins row identity; acquiring or replacing it requires publication.
      previous.terminalHandle === (terminalHandle ?? previous.terminalHandle) &&
      terminalStatusPayloadMatchesHook(previous.payload, event.payload, preserveActiveTurnStamp) &&
      // OSC 7501 child-only changes still require publication; absent children means none remain.
      (event.fromProgramStatus !== true ||
        agentSubagentsEqual(previous.payload.subagents, event.payload.subagents))
    ) {
      // An authority transfer must refresh enriched subscribers even for an identical payload.
      this.refreshTerminalStatusEvidence(
        previous,
        mutationBefore,
        mutationBefore !== undefined || event.renewsProgramStatusLease === true,
        newRun
      )
      return
    }
    // Terminal status carries no provider session; retain eligible cached identity without treating unknown as a mismatch (#10630).
    const claimedAgentType =
      event.payload.agentType && event.payload.agentType !== 'unknown'
        ? event.payload.agentType
        : undefined
    // A live agent's turn after `done` keeps its session (OSC 7501 reports hookless slash commands); a new run or an exited agent's resume-only row does not. Launch seeds are not completed turns.
    const preservedProviderSession =
      previous?.providerSession &&
      (claimedAgentType === undefined || claimedAgentType === previous.payload.agentType) &&
      (previous.payload.state !== 'done' ||
        event.payload.state === 'done' ||
        previous.observation?.origin === 'launch' ||
        (!newRun && previous.providerSessionOnly !== true))
        ? previous.providerSession
        : undefined
    // Without a new main-agent fact, preserve it only while the row's state and agent still match.
    const preservedMainAgent =
      event.payload.mainAgent ??
      (previous?.payload.mainAgent &&
      previous.payload.state === event.payload.state &&
      (claimedAgentType === undefined || claimedAgentType === previous.payload.agentType)
        ? previous.payload.mainAgent
        : undefined)
    // Terminal observations cannot establish prompt-sent telemetry.
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
