import {
  AGENT_STATUS_HYDRATE_MAX_AGE_MS,
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusAuthorityObservedAt,
  pickParsedAgentStatusPayload,
  type AgentStatusEntry,
  type AgentStatusIpcPayload
} from '../../shared/agent-status-types'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { terminalTitleBlocksExplicitAgentStatus } from './runtime-worktree-status-projection'
import type { HookLiveAgentRow } from './runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

export function renewRuntimeMobileAgentStatusFromPtyTitle(
  status: AgentStatusEntry | null,
  pty: RuntimePtyWorktreeRecord | null,
  options: { preserveQuestionUnderShellTitle?: boolean } = {}
): AgentStatusEntry | null {
  if (!status || !pty) {
    return status
  }
  // Same-class Claude title repaints can postdate a fresh permission hook without
  // contradicting it; only a working or released-pane title retires the question (#11761).
  if (
    (status.state === 'waiting' || status.state === 'blocked') &&
    pty.lastAgentStatus === 'idle' &&
    Date.now() - agentStatusAuthorityObservedAt(status) <= AGENT_STATUS_STALE_AFTER_MS
  ) {
    return status
  }
  if (
    options.preserveQuestionUnderShellTitle &&
    status.interactivePrompt != null &&
    terminalTitleBlocksExplicitAgentStatus(pty.lastOscTitle)
  ) {
    return status
  }
  const richStatusCanOwnTitleInterval =
    pty.lastAgentStatusRichInvalidatedAtEpochMs === null ||
    agentStatusAuthorityObservedAt(status) > pty.lastAgentStatusRichInvalidatedAtEpochMs
  const titleEvidenceAt = pty.lastOscTitleEpochMs
  if (titleEvidenceAt === null) {
    return richStatusCanOwnTitleInterval ? status : null
  }
  const buildTitleOnlyStatus = (
    state: AgentStatusEntry['state'],
    updatedAt: number,
    stateStartedAt: number
  ): AgentStatusEntry => ({
    state,
    prompt: '',
    updatedAt,
    stateStartedAt,
    paneKey: status.paneKey,
    stateHistory: [],
    ...(status.agentType ? { agentType: status.agentType } : {}),
    ...(status.terminalHandle ? { terminalHandle: status.terminalHandle } : {}),
    ...(status.worktreeId ? { worktreeId: status.worktreeId } : {}),
    ...(status.tabId ? { tabId: status.tabId } : {}),
    ...(status.terminalTitle ? { terminalTitle: status.terminalTitle } : {}),
    ...(status.providerSession ? { providerSession: status.providerSession } : {})
  })
  const titleConfirmsState =
    (pty.lastAgentStatus === 'working' && status.state === 'working') ||
    (pty.lastAgentStatus === 'permission' &&
      (status.state === 'blocked' || status.state === 'waiting'))
  if (!titleConfirmsState) {
    if (
      richStatusCanOwnTitleInterval &&
      agentStatusAuthorityObservedAt(status) >= titleEvidenceAt
    ) {
      return status
    }
    if (pty.lastAgentStatus === null && !terminalTitleBlocksExplicitAgentStatus(pty.lastOscTitle)) {
      // Why: an earlier title-only `working` was published at a later stamp; returning the
      // older hook stamp makes clients keep that `working` forever (#28102). updatedAt is
      // the ordering clock, so advance it while evidenceObservedAt keeps freshness honest.
      return status.state !== 'working' && titleEvidenceAt > status.updatedAt
        ? {
            ...status,
            updatedAt: titleEvidenceAt,
            evidenceObservedAt: agentStatusAuthorityObservedAt(status)
          }
        : status
    }
    const titleState =
      pty.lastAgentStatus === 'working'
        ? 'working'
        : pty.lastAgentStatus === 'permission'
          ? 'blocked'
          : 'done'
    return buildTitleOnlyStatus(
      titleState,
      titleEvidenceAt,
      pty.lastAgentStatusStartedAtEpochMs ?? titleEvidenceAt
    )
  }
  const richStatusOwnsCurrentState =
    Date.now() - agentStatusAuthorityObservedAt(status) <= AGENT_STATUS_STALE_AFTER_MS &&
    richStatusCanOwnTitleInterval
  // Fresh explicit evidence from this title interval owns acknowledgement identity.
  const stateStartedAt = richStatusOwnsCurrentState
    ? status.stateStartedAt
    : (pty.lastAgentStatusStartedAtEpochMs ?? status.stateStartedAt)
  if (richStatusOwnsCurrentState) {
    pty.lastAgentStatusStartedAtEpochMs = stateStartedAt
  }
  const updatedAt = Math.max(status.updatedAt, titleEvidenceAt)
  if (!richStatusOwnsCurrentState) {
    return buildTitleOnlyStatus(status.state, updatedAt, stateStartedAt)
  }
  return updatedAt === status.updatedAt && stateStartedAt === status.stateStartedAt
    ? status
    : { ...status, updatedAt, stateStartedAt }
}

export type RuntimeHookAgentRowLookup = {
  providerSession: AgentProviderSessionMetadata | null
  providerSessionAgentType: string | null
  providerSessionReceivedAt: number | null
  agentType: string | null
  agentIsLive: boolean
  live: HookLiveAgentRow | null
  /** Latest nonterminal row hydrated across a host restart: unverifiable, never live. */
  restored: HookLiveAgentRow | null
}

/** Resume identity stays valid until relaunch; ownership and live status remain freshness-bounded. */
export function selectRuntimeHookAgentRowForPane(
  rows: readonly AgentStatusIpcPayload[]
): RuntimeHookAgentRowLookup {
  let session: AgentStatusIpcPayload | null = null
  let agent: AgentStatusIpcPayload | null = null
  let live: AgentStatusIpcPayload | null = null
  let restored: AgentStatusIpcPayload | null = null
  let confirmedReceivedAt = -Infinity
  const now = Date.now()
  const freshAfter = now - AGENT_STATUS_STALE_AFTER_MS
  // Unverifiable lasts as long as hydration keeps the row; going quiet is not exit evidence.
  const restoredAfter = now - AGENT_STATUS_HYDRATE_MAX_AGE_MS
  for (const entry of rows) {
    if (entry.providerSession && (!session || entry.receivedAt > session.receivedAt)) {
      session = entry
    }
    if (
      entry.agentType &&
      (entry.providerSessionOnly !== true ||
        (entry.agentType === 'pi' && entry.providerSession != null)) &&
      (entry.evidenceObservedAt ?? entry.receivedAt) >= freshAfter &&
      (!agent || entry.receivedAt > agent.receivedAt)
    ) {
      agent = entry
    }
    if (entry.providerSessionOnly !== true && entry.restoredUnconfirmed !== true) {
      confirmedReceivedAt = Math.max(confirmedReceivedAt, entry.receivedAt)
    }
    if (
      entry.providerSessionOnly !== true &&
      // Restored rows cannot prove liveness because the turn may have ended while offline (#12346).
      entry.restoredUnconfirmed !== true &&
      (entry.evidenceObservedAt ?? entry.receivedAt) >= freshAfter &&
      (!live || entry.receivedAt > live.receivedAt)
    ) {
      live = entry
    }
    if (
      entry.providerSessionOnly !== true &&
      entry.restoredUnconfirmed === true &&
      entry.state !== 'done' &&
      (entry.evidenceObservedAt ?? entry.receivedAt) >= restoredAfter &&
      (!restored || entry.receivedAt > restored.receivedAt)
    ) {
      restored = entry
    }
  }
  // A confirmed row at least as new as the restored one supersedes it, stale or not.
  if (restored && confirmedReceivedAt >= restored.receivedAt) {
    restored = null
  }
  return {
    providerSession: session?.providerSession ?? null,
    providerSessionAgentType: session?.agentType ?? null,
    providerSessionReceivedAt: session?.receivedAt ?? null,
    agentType: agent?.agentType ?? null,
    agentIsLive: agent != null && agent.state !== 'done',
    live: live ? toHookLiveAgentRow(live) : null,
    restored: restored ? toHookLiveAgentRow(restored) : null
  }
}

function toHookLiveAgentRow(row: AgentStatusIpcPayload): HookLiveAgentRow {
  return {
    payload: pickParsedAgentStatusPayload(row),
    updatedAt: row.receivedAt,
    ...(row.evidenceObservedAt !== undefined ? { evidenceObservedAt: row.evidenceObservedAt } : {}),
    stateStartedAt: row.stateStartedAt ?? row.receivedAt,
    ...(row.worktreeId ? { worktreeId: row.worktreeId } : {}),
    ...(row.programStatus ? { programStatus: row.programStatus } : {})
  }
}

export function resolveRuntimeHookLiveAgentRow(
  live: HookLiveAgentRow | null,
  pty: RuntimePtyWorktreeRecord | null,
  nonAgentTitle: boolean
): HookLiveAgentRow | null {
  if (!live) {
    return null
  }
  if (live.payload.interactivePrompt != null) {
    return live
  }
  // This is the pane's only wall-clock title timestamp comparable to when the hook evidence
  // was observed; replay delivery order must not make old evidence outrank a newer title.
  return !nonAgentTitle &&
    agentStatusAuthorityObservedAt({
      updatedAt: live.updatedAt,
      evidenceObservedAt: live.evidenceObservedAt
    }) >= (pty?.lastOscTitleEpochMs ?? 0)
    ? live
    : null
}
