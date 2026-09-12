import { track } from '../../telemetry/client'
import { MAX_PANE_KEY_LEN } from '../../../shared/agent-hook-listener/listener-limits'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { terminalStatusPayloadMatchesHook } from '../../../shared/agent-terminal-status-equivalence'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'
import {
  parseAgentStatusSubject,
  type AgentStatusSubject
} from '../../../shared/agent-status-subject'

export abstract class AgentHookServerIngestTerminal extends AgentHookServerIngestNormalization {
  ingestTerminalStatus(event: {
    ptyId?: string
    paneKey: string
    tabId?: string
    worktreeId?: string
    connectionId?: string | null
    terminalHandle?: string
    subject?: AgentStatusSubject
    payload: ParsedAgentStatusPayload
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
    if (this.getAgentStatusDisposition(paneKey) !== 'accept') {
      return
    }
    const worktreeId =
      event.worktreeId !== undefined && event.worktreeId.trim().length > 0
        ? event.worktreeId.trim()
        : undefined
    const connectionId =
      typeof event.connectionId === 'string' && event.connectionId.trim().length > 0
        ? event.connectionId.trim()
        : null
    const terminalHandle =
      typeof event.terminalHandle === 'string' && event.terminalHandle.trim().length > 0
        ? event.terminalHandle.trim()
        : undefined
    const suppliedSubject = parseAgentStatusSubject(event.subject)
    let subject =
      suppliedSubject?.kind === 'pty' && suppliedSubject.paneKey === paneKey
        ? suppliedSubject
        : this.legacyPtyStatusSubjectFor({ paneKey, worktreeId, connectionId })
    let mutationBefore: EnrichedAgentHookEventPayload | undefined
    const indexedStatusKey = terminalHandle
      ? this.getStatusKeyForTerminalHandle(terminalHandle)
      : undefined
    if (indexedStatusKey) {
      const indexedStatus = this.state.lastStatusByPaneKey.get(indexedStatusKey) as
        | EnrichedAgentHookEventPayload
        | undefined
      if (
        indexedStatus &&
        indexedStatus.paneKey !== paneKey &&
        indexedStatus.terminalHandle === terminalHandle &&
        this.sameTerminalOwner(indexedStatus, { connectionId, worktreeId })
      ) {
        mutationBefore = indexedStatus
        this.transferPaneAuthority(indexedStatus.paneKey, paneKey, event.ptyId, Date.now(), {
          authorityVerified: true,
          emitStatusRowMutation: false
        })
        paneKey = this.resolvePaneKeyAlias(paneKey)
        subject = this.legacyPtyStatusSubjectFor({ paneKey, worktreeId, connectionId })
      }
    }
    const previous = this.statusEntryFor({
      subject,
      paneKey,
      worktreeId,
      connectionId,
      payload: event.payload
    })
    if (
      previous?.claudeLeadBoundaryChildOnly === true &&
      previous.payload.agentType === 'claude' &&
      event.payload.agentType === 'claude'
    ) {
      // Why: OSC has no child identity or lead boundary, so it cannot replace a persisted child-only proof before the lifecycle hook arrives.
      if (mutationBefore !== undefined) {
        this.commitStatusRowMutation(mutationBefore, previous)
        this.emitEnrichedStatus(previous)
      }
      return
    }
    // Why: preserve the hook-completed turn stamp while OSC repaints the current state.
    const preserveActiveTurnStamp =
      previous?.payload.turnCompletedAt !== undefined &&
      previous.payload.turnCompletedAt ===
        this.activeHookTurnCompletedAtByPaneKey.get(this.statusKeyFor(previous))
    if (
      !previous?.restoredUnconfirmed &&
      previous?.connectionId === connectionId &&
      previous.tabId === tabId &&
      previous.worktreeId === worktreeId &&
      // Why in the unchanged gate: the handle is a join key readers match on, so a pane that
      // only just acquired one (or moved to another) must still refresh the row it is stamped on.
      previous.terminalHandle === (terminalHandle ?? previous.terminalHandle) &&
      terminalStatusPayloadMatchesHook(previous.payload, event.payload, preserveActiveTurnStamp)
    ) {
      // A handle-authority transfer is a new pane observation even when its payload is a
      // duplicate; enriched subscribers must capture the replacement pane identity.
      this.refreshTerminalStatusEvidence(previous, mutationBefore, mutationBefore !== undefined)
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
    const preservedProviderSession =
      previous?.providerSession &&
      (claimedAgentType === undefined || claimedAgentType === previous.payload.agentType) &&
      (previous.payload.state !== 'done' || event.payload.state === 'done')
        ? previous.providerSession
        : undefined
    // Why: OSC status is a runtime observation, not a prompt boundary; keep prompt-sent telemetry tied to native hooks.
    this.applyNormalizedStatus(
      {
        subject,
        paneKey,
        tabId,
        worktreeId,
        connectionId,
        ...(preservedProviderSession ? { providerSession: preservedProviderSession } : {}),
        ...(terminalHandle ? { terminalHandle } : {}),
        payload: event.payload
      },
      undefined,
      'osc',
      undefined,
      mutationBefore
    )
  }
}
