import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  workingHookOwnsIdleTitleInterval,
  codexHookReportsRunningTurn,
  completedTurnFields,
  ptyStatusEvidenceAt
} from './runtime-mobile-agent-status-evidence'
import {
  AGENT_STATUS_HYDRATE_MAX_AGE_MS,
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusAuthorityObservedAt
} from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { terminalTitleBlocksExplicitAgentStatus } from '../../workspaces/process-listing/runtime-worktree-status-projection'
import {
  toHookLiveAgentRow,
  type HookLiveAgentRow
} from '../../workspaces/process-listing/hook-live-agent-row'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import { codexAsyncQuestionOutlivesWorkingTitle } from './codex-async-question-title-hold'

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
    ((status.state === 'waiting' || status.state === 'blocked') &&
      pty.lastAgentStatus === 'idle' &&
      Date.now() - agentStatusAuthorityObservedAt(status) <= AGENT_STATUS_STALE_AFTER_MS) ||
    codexAsyncQuestionOutlivesWorkingTitle(status, pty)
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
    codexHookReportsRunningTurn(status, agentStatusAuthorityObservedAt(status), pty) ||
    pty.lastAgentStatusRichInvalidatedAtEpochMs === null ||
    agentStatusAuthorityObservedAt(status) > pty.lastAgentStatusRichInvalidatedAtEpochMs
  const titleEvidenceAt = pty.lastOscTitleEpochMs
  // Idle/shutdown titles describe presence, not a second end of an already completed turn.
  if (
    status.state === 'done' &&
    (status.paneSleep ||
      (status.restoredUnconfirmed !== true &&
        pty.lastAgentStatus !== 'working' &&
        pty.lastAgentStatus !== 'permission'))
  ) {
    const updatedAt = Math.max(status.updatedAt, titleEvidenceAt ?? 0)
    return updatedAt === status.updatedAt
      ? status
      : { ...status, updatedAt, evidenceObservedAt: agentStatusAuthorityObservedAt(status) }
  }
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
    ...(status.providerSession ? { providerSession: status.providerSession } : {}),
    ...(status.orcaSessionId !== undefined ? { orcaSessionId: status.orcaSessionId } : {}),
    ...(state === 'done' ? completedTurnFields(status) : {})
  })
  const titleConfirmsState =
    (pty.lastAgentStatus === 'working' && status.state === 'working') ||
    (pty.lastAgentStatus === 'permission' &&
      (status.state === 'blocked' || status.state === 'waiting'))
  if (!titleConfirmsState) {
    // A repaint of the idle interval preceding this hook is not a new turn boundary.
    if (workingHookOwnsIdleTitleInterval(status, agentStatusAuthorityObservedAt(status), pty)) {
      return status
    }
    if (
      richStatusCanOwnTitleInterval &&
      agentStatusAuthorityObservedAt(status) >= titleEvidenceAt
    ) {
      return status
    }
    if (pty.lastAgentStatus === null && !terminalTitleBlocksExplicitAgentStatus(pty.lastOscTitle)) {
      // Advance updatedAt past prior title-only working so clients accept the hook; preserve evidenceObservedAt for freshness (#28102).
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
      ptyStatusEvidenceAt(pty, titleEvidenceAt),
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
    return buildTitleOnlyStatus(status.state, ptyStatusEvidenceAt(pty, updatedAt), stateStartedAt)
  }
  return updatedAt === status.updatedAt && stateStartedAt === status.stateStartedAt
    ? status
    : { ...status, updatedAt, stateStartedAt }
}

export type RuntimeHookAgentRowLookup = {
  providerSession: AgentProviderSessionMetadata | null
  /** The host's Orca id for that provider session's conversation (see `AgentStatusEntry`). */
  orcaSessionId: string | null | undefined
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
      (entry.paneSleep || (entry.evidenceObservedAt ?? entry.receivedAt) >= freshAfter) &&
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
      (entry.paneSleep || (entry.evidenceObservedAt ?? entry.receivedAt) >= freshAfter) &&
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
    orcaSessionId: session?.orcaSessionId,
    providerSessionAgentType: session?.agentType ?? null,
    providerSessionReceivedAt: session?.receivedAt ?? null,
    agentType: agent?.agentType ?? null,
    agentIsLive: agent != null && agent.state !== 'done',
    live: live ? toHookLiveAgentRow(live) : null,
    restored: restored ? toHookLiveAgentRow(restored) : null
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
  if (live.paneSleep) {
    return live
  }
  if (live.payload.interactivePrompt != null) {
    return live
  }
  if (
    !terminalTitleBlocksExplicitAgentStatus(pty?.lastOscTitle ?? null) &&
    live.payload.state === 'done' &&
    pty?.lastAgentStatus !== 'working' &&
    pty?.lastAgentStatus !== 'permission'
  ) {
    return live
  }
  if (workingHookOwnsIdleTitleInterval(live.payload, agentStatusAuthorityObservedAt(live), pty)) {
    return live
  }
  // Compare hook evidence against the pane's PTY wall-clock title, never replay delivery order.
  return !nonAgentTitle &&
    agentStatusAuthorityObservedAt({
      updatedAt: live.updatedAt,
      evidenceObservedAt: live.evidenceObservedAt
    }) >= (pty?.lastOscTitleEpochMs ?? 0)
    ? live
    : null
}

export {
  demoteRuntimeMobileAgentStatus,
  ptyStatusEvidenceAt
} from './runtime-mobile-agent-status-evidence'
