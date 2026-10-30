import {
  normalizeCompatibleAgentStatusEntryForOwner,
  normalizeCompatibleAgentTitleForOwner
} from '../../shared/agent-title-owner'
import { resolvePaneAgentOwnerRecord } from '../../shared/pane-agent-owner'
import {
  agentStatusAuthorityObservedAt,
  pickHostTurnEnd,
  type AgentStatusEntry,
  type AgentStatusIpcPayload,
  type HostTurnEndFacts
} from '../../shared/agent-status-types'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import {
  renewRuntimeMobileAgentStatusFromPtyTitle,
  resolveRuntimeHookLiveAgentRow,
  selectRuntimeHookAgentRowForPane
} from './runtime-mobile-agent-status-projection'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeAgentRowSnapshot } from './runtime-worktree-agent-rows'
import {
  classifyAgentTitle,
  getLatestAgentCandidate,
  getLatestPtyTitle,
  terminalTitleBlocksExplicitAgentStatus
} from './runtime-worktree-status-projection'

type RuntimeMobileAgentStatusHost = {
  getPaneKey(tab: RuntimeMobileSessionTerminalTab): string
  getLeaf(tab: RuntimeMobileSessionTerminalTab): RuntimeLeafRecord | null
  getTrackedTitle(ptyId: string | null): string | null
  /** Wall clock of the PTY's latest live OSC title; seeded restore titles leave it unset. */
  getPtyTitleObservedAtEpochMs?(ptyId: string | null): number | null
  /** When main started the PTY's current process; null when it attached to a running one. */
  getPtyProcessStartedAtEpochMs?(ptyId: string): number | null
}

export function buildRuntimeMobileAgentStatus(
  pty: RuntimePtyWorktreeRecord | null,
  tab: RuntimeMobileSessionTerminalTab,
  terminalHandle: string | null,
  retained: RuntimeAgentRowSnapshot | null,
  getHookRowsForPane: (paneKey: string) => AgentStatusIpcPayload[],
  host: RuntimeMobileAgentStatusHost
): { agentStatus: AgentStatusEntry } | Record<string, never> {
  const paneKey = host.getPaneKey(tab)
  // Only full hook payload carries provider session identity; headless has no renderer tab.agentStatus, so native chat needs this path.
  const hookRows = getHookRowsForPane(paneKey)
  const hookRow = selectRuntimeHookAgentRowForPane(hookRows)
  // Check hook evidence even without PTY status: headless hook-only agents may never publish recognized titles.
  if (!pty?.lastAgentStatus && !retained && !hookRow.agentType && !hookRow.providerSession) {
    return {}
  }
  const providerSession = hookRow.providerSession
    ? { providerSession: hookRow.providerSession }
    : retained?.providerSession
      ? { providerSession: retained.providerSession }
      : {}
  const leaf = host.getLeaf(tab)
  const trackerOnlyTitle = host.getTrackedTitle(pty?.ptyId ?? leaf?.ptyId ?? null)
  const titleCandidate = pty
    ? getLatestAgentCandidate(
        {
          title: pty.title,
          updatedAt: pty.titleUpdatedAt,
          observedAtEpochMs: pty.titleObservedAtEpochMs ?? null
        },
        {
          title: pty.lastOscTitle,
          updatedAt: pty.lastOscTitleAt,
          observedAtEpochMs: pty.lastOscTitleEpochMs
        }
      )
    : leaf
      ? getLatestAgentCandidate(
          { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt, observedAtEpochMs: null },
          {
            title: leaf.lastOscTitle,
            updatedAt: leaf.lastOscTitleAt,
            observedAtEpochMs: host.getPtyTitleObservedAtEpochMs?.(leaf.ptyId) ?? null
          }
        )
      : null
  const ptyTitle = titleCandidate?.title?.trim() || null
  const ptyTitleClassification = classifyAgentTitle(ptyTitle)
  const nonAgentTitle = ptyTitle !== null && ptyTitleClassification !== 'agent'
  if (nonAgentTitle) {
    // Shell titles clear stuck spinners unless a live hook still proves agent activity (#1437).
    const hasLiveHookSignal =
      retained?.payload.interactivePrompt != null ||
      retained?.payload.toolName != null ||
      // Questions are never inherited between hook events, so one proves the agent is parked on a selector.
      hookRow.live?.payload.interactivePrompt != null ||
      // A first-turn hook can arrive while the pre-launch shell title is still painted.
      (hookRow.live?.payload.agentType != null &&
        titleCandidate?.observedAtEpochMs != null &&
        agentStatusAuthorityObservedAt(hookRow.live) > titleCandidate.observedAtEpochMs) ||
      // Headless hook-only agents need no recognized title. With PTY status, only shell/management proves release; Codex idle may use project name (#31136).
      // Derive status below from the PTY title state.
      ((!pty?.lastAgentStatus || !terminalTitleBlocksExplicitAgentStatus(ptyTitle)) &&
        (hookRow.agentType != null || hookRow.providerSession != null))
    if (!hasLiveHookSignal) {
      return {}
    }
  }
  // Why: a retained OMP hook stays stable while wrapper foreground reads can report Pi.
  const ownerRecord = resolvePaneAgentOwnerRecord({
    launchAgent: tab.launchAgent ?? pty?.launchAgent ?? null,
    hookAgent: retained?.payload.agentType ?? hookRow.agentType
  })
  const ownerAgent = ownerRecord?.agent ?? pty?.foregroundAgent ?? null
  const ownerOptions = { ownerIsLaunch: ownerRecord?.ownerIsLaunch === true }
  const terminalTitle = normalizeCompatibleAgentTitleForOwner(
    trackerOnlyTitle ?? (pty ? getLatestPtyTitle(pty) : null) ?? tab.title,
    ownerAgent,
    ownerOptions
  )
  // Why the superseded turn's segment: a client that saw it reads this as a replay, not a new
  // completion to announce. Only updatedAt advances, so the client's copy cannot outrank it.
  const identityOnly = (
    updatedAt: number,
    segment: { stateStartedAt: number } & HostTurnEndFacts
  ): { agentStatus: AgentStatusEntry } => {
    const agentType = ownerAgent ?? hookRow.agentType ?? hookRow.providerSessionAgentType
    return {
      agentStatus: normalizeCompatibleAgentStatusEntryForOwner(
        {
          state: 'done',
          prompt: '',
          updatedAt,
          stateStartedAt: segment.stateStartedAt,
          ...pickHostTurnEnd(segment),
          // Why: clients render an unverifiable row as no status yet keep its identity, so native
          // chat still finds the session; clients that cannot read it get the legacy `done`.
          restoredUnconfirmed: true,
          paneKey,
          ...(terminalHandle ? { terminalHandle } : {}),
          ...(agentType ? { agentType } : {}),
          ...((pty?.worktreeId ?? leaf?.worktreeId)
            ? { worktreeId: pty?.worktreeId ?? leaf?.worktreeId }
            : {}),
          tabId: tab.parentTabId,
          terminalTitle,
          stateHistory: [],
          ...providerSession
        },
        ownerAgent,
        ownerOptions
      )
    }
  }
  // Why: evidence from before main started this process describes an earlier one, so a fresh
  // shell after a restore must not wear that turn's state. An attached process has no start here,
  // and a relay replay that restamps receivedAt later only keeps the status as it was.
  const processPtyId = pty?.ptyId ?? leaf?.ptyId
  const processStartedAt = processPtyId ? host.getPtyProcessStartedAtEpochMs?.(processPtyId) : null
  const newestEvidenceAt = Math.max(
    retained?.updatedAt ?? -Infinity,
    ...hookRows.map((row) => row.receivedAt)
  )
  // The segment is the turn a client was shown; a later resume-identity row is not a turn.
  const shownSegment =
    retained ??
    hookRow.live ??
    hookRow.restored ??
    newestHookRow(hookRows.filter((row) => row.providerSessionOnly !== true)) ??
    newestHookRow(hookRows)
  if (
    processStartedAt != null &&
    shownSegment &&
    newestEvidenceAt < processStartedAt &&
    !pty?.lastAgentStatus &&
    !leaf?.lastAgentStatus
  ) {
    return identityOnly(processStartedAt, shownSegment)
  }
  // Prefer OSC 9999 state/prompt/agent so hook-only transitions surface (#7970).
  const liveRow = retained ?? resolveRuntimeHookLiveAgentRow(hookRow.live, pty, nonAgentTitle)
  if (liveRow) {
    const liveStatus = normalizeCompatibleAgentStatusEntryForOwner(
      {
        ...liveRow.payload,
        paneKey,
        updatedAt: liveRow.updatedAt,
        ...(liveRow.evidenceObservedAt !== undefined
          ? { evidenceObservedAt: liveRow.evidenceObservedAt }
          : {}),
        stateStartedAt: liveRow.stateStartedAt,
        ...pickHostTurnEnd(liveRow),
        stateHistory: [],
        ...(terminalHandle ? { terminalHandle } : {}),
        ...((pty?.worktreeId ?? liveRow.worktreeId)
          ? { worktreeId: pty?.worktreeId ?? liveRow.worktreeId }
          : {}),
        tabId: tab.parentTabId,
        terminalTitle,
        ...providerSession,
        ...(liveRow.programStatus ? { programStatus: liveRow.programStatus } : {})
      },
      ownerAgent,
      ownerOptions
    )
    // A live question outranks only the shell title that currently obscures it.
    const renewedStatus = renewRuntimeMobileAgentStatusFromPtyTitle(liveStatus, pty, {
      preserveQuestionUnderShellTitle: true
    })
    if (renewedStatus) {
      return { agentStatus: renewedStatus }
    }
  }
  // Restored turns are unverifiable: retain original date and omit question fields (#12346).
  // Later shell evidence keeps identity only; showing Done would claim an unseen completion.
  const titleObservedAt =
    pty?.lastOscTitleEpochMs ?? host.getPtyTitleObservedAtEpochMs?.(leaf?.ptyId ?? null) ?? 0
  const shellTitleRetiredRestored =
    hookRow.restored !== null &&
    terminalTitleBlocksExplicitAgentStatus(ptyTitle) &&
    titleObservedAt >= hookRow.restored.updatedAt
  if (shellTitleRetiredRestored && hookRow.restored && !pty?.lastAgentStatus) {
    return identityOnly(titleObservedAt, hookRow.restored)
  }
  const restored = !pty?.lastAgentStatus && !shellTitleRetiredRestored ? hookRow.restored : null
  if (restored) {
    const restoredAgentType = ownerAgent ?? restored.payload.agentType
    return {
      agentStatus: normalizeCompatibleAgentStatusEntryForOwner(
        {
          state: restored.payload.state,
          prompt: restored.payload.prompt,
          updatedAt: restored.updatedAt,
          stateStartedAt: restored.stateStartedAt,
          restoredUnconfirmed: true,
          paneKey,
          ...(terminalHandle ? { terminalHandle } : {}),
          ...(restoredAgentType ? { agentType: restoredAgentType } : {}),
          ...((pty?.worktreeId ?? restored.worktreeId)
            ? { worktreeId: pty?.worktreeId ?? restored.worktreeId }
            : {}),
          tabId: tab.parentTabId,
          terminalTitle,
          stateHistory: [],
          ...providerSession
        },
        ownerAgent,
        ownerOptions
      )
    }
  }
  // Rejected/stale/resume hook evidence proves identity only; title-derived done retires exited cards.
  // Date it by title evidence, not lastOutputAt, or every output byte outranks clients' live status.
  const evidenceAt = pty?.lastOscTitleEpochMs ?? hookRow.providerSessionReceivedAt ?? Date.now()
  const agentType = ownerAgent ?? undefined
  return {
    agentStatus: {
      state:
        pty?.lastAgentStatus === 'working'
          ? 'working'
          : pty?.lastAgentStatus === 'permission'
            ? 'blocked'
            : 'done',
      prompt: '',
      updatedAt: evidenceAt,
      stateStartedAt: pty?.lastAgentStatusStartedAtEpochMs ?? evidenceAt,
      paneKey,
      ...(terminalHandle ? { terminalHandle } : {}),
      ...(agentType ? { agentType } : {}),
      ...(pty?.worktreeId ? { worktreeId: pty.worktreeId } : {}),
      tabId: tab.parentTabId,
      terminalTitle,
      stateHistory: [],
      ...providerSession
    }
  }
}

function newestHookRow(rows: readonly AgentStatusIpcPayload[]): AgentStatusIpcPayload | null {
  return rows.reduce<AgentStatusIpcPayload | null>(
    (newest, row) => (!newest || row.receivedAt > newest.receivedAt ? row : newest),
    null
  )
}
