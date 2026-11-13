import type { TerminalStatusIngestEvent } from './terminal-status-ingest-event'
import type { LaunchResumeIdentityEvent } from './launch-resume-identity-event'
import { trackEmptyPaneKeyHook } from './server-transport-rules'
import { MAX_PANE_KEY_LEN } from '../../../shared/agent-hook-listener/listener-limits'
import {
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../shared/workspace-layout/stable-pane-id'
import { terminalStatusPayloadMatchesHook } from '../../../shared/agent-status/lifecycle/agent-terminal-status-equivalence'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status/contracts/agent-status-types'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { agentSubagentsEqual } from '../../../shared/agent-status/contracts/agent-status-subagent-snapshot'
import { isAgentStatusHeldOpenByChildWork } from '../../../shared/agent-status/lifecycle/agent-lead-status-fold'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'
import { programStatusHookYieldEndsAt } from './program-status/hook-precedence'
import type { ProgramStatusFacet } from '../../../shared/program-status/facet'

const PROGRAM_STATUS_FACET_REPUBLISH_MS = 250

export abstract class AgentHookServerIngestTerminal extends AgentHookServerIngestNormalization {
  /** Seed resume identity before the first hook; Codex SessionStart waits for the first turn (#10923). */
  recordLaunchResumeIdentity(event: LaunchResumeIdentityEvent): void {
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

  ingestTerminalStatus(event: TerminalStatusIngestEvent): void {
    const physicalPaneKey = event.paneKey.trim()
    let paneKey = this.resolvePaneKeyAlias(physicalPaneKey)
    const parsedPaneKey = parsePaneKey(paneKey)
    const legacyPaneKey = parseLegacyNumericPaneKey(paneKey)
    if (paneKey.length === 0) {
      trackEmptyPaneKeyHook(event, this.attributionDiagnostics)
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
    // OSC 7501 names OpenCode 2 `opencode`; the row its hook or launch named keeps the generation.
    const payload: ParsedAgentStatusPayload =
      event.fromProgramStatus === true &&
      event.payload.agentType === 'opencode' &&
      previous?.payload.agentType === 'opencode2'
        ? { ...event.payload, agentType: 'opencode2' }
        : event.payload
    // OpenCode 1 run loads hooks in-process; a hook during the command owns its status.
    const hookOwnsCommand =
      event.yieldsToHookSince !== undefined &&
      previous?.observation?.origin === 'hook' &&
      previous.receivedAt >= event.yieldsToHookSince
    const now = Date.now()
    // Record ordering before removal, which also marks a program turn boundary.
    const workingSince =
      event.fromProgramStatus === true
        ? this.programStatusFacets.noteState(paneKey, payload, now)
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
        ? programStatusHookYieldEndsAt(previous, payload, workingSince)
        : undefined
    const hookOwnsAgent = yieldEndsAt !== undefined && now < yieldEndsAt
    if (event.fromProgramStatus === true) {
      if (hookOwnsAgent && previous && Number.isFinite(yieldEndsAt)) {
        const yieldedTo = previous.receivedAt
        const delayMs = yieldEndsAt - now
        const replay = { ...event, isReplay: true as const }
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
            this.ingestTerminalStatus({ ...replay, paneKey: currentPaneKey, tabId })
          }
        })
      } else {
        this.hookSilenceRechecks.cancel(paneKey)
      }
    }
    if (event.fromProgramStatus && !event.renewsProgramStatusLease && !event.isReplay) {
      const owner = hookOwnsAgent && previous ? previous : { connectionId, payload }
      this.producerProgress.observe(
        { paneKey, connectionId: owner.connectionId, payload: owner.payload },
        now,
        newRun
      )
    }
    if (
      hookOwnsCommand ||
      hookOwnsAgent ||
      // OSC 7501 uses the hook precedence above; other terminal reports cannot settle child-held work.
      (event.fromProgramStatus !== true &&
        previous?.payload.agentType === 'claude' &&
        payload.agentType === 'claude' &&
        isAgentStatusHeldOpenByChildWork(previous.payload) &&
        previous.payload.subagents?.some((subagent) => subagent.state === 'working') === true)
    ) {
      if (previous && mutationBefore !== undefined) {
        this.commitStatusRowMutation(mutationBefore, previous)
        this.emitEnrichedStatus(previous)
      }
      if (hookOwnsAgent && previous) {
        this.settleClaudePromptBlocked(previous)
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
      terminalStatusPayloadMatchesHook(previous.payload, payload, preserveActiveTurnStamp) &&
      // OSC 7501 child-only changes still require publication; absent children means none remain.
      (event.fromProgramStatus !== true ||
        agentSubagentsEqual(previous.payload.subagents, payload.subagents))
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
      payload.agentType && payload.agentType !== 'unknown' ? payload.agentType : undefined
    // A live agent's turn after `done` keeps its session (OSC 7501 reports hookless slash commands); a new run or an exited agent's resume-only row does not. Launch seeds are not completed turns.
    const preservedProviderSession =
      previous?.providerSession &&
      (claimedAgentType === undefined || claimedAgentType === previous.payload.agentType) &&
      (previous.payload.state !== 'done' ||
        payload.state === 'done' ||
        previous.observation?.origin === 'launch' ||
        (!newRun && previous.providerSessionOnly !== true))
        ? previous.providerSession
        : undefined
    // Without a new main-agent fact, preserve it only while the row's state and agent still match.
    const preservedMainAgent =
      payload.mainAgent ??
      (previous?.payload.mainAgent &&
      previous.payload.state === payload.state &&
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
        payload: preservedMainAgent ? { ...payload, mainAgent: preservedMainAgent } : payload
      },
      undefined,
      event.origin ?? 'osc',
      undefined,
      mutationBefore,
      newRun,
      !preservedProviderSession
    )
  }
}
