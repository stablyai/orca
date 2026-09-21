import {
  normalizeCompatibleAgentStatusEntryForOwner,
  normalizeCompatibleAgentTitleForOwner
} from '../../shared/agent-title-owner'
import { resolvePaneAgentOwnerRecord } from '../../shared/pane-agent-owner'
import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../shared/agent-status-types'
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
  getLatestAgentCandidateTitle,
  getLatestPtyTitle
} from './runtime-worktree-status-projection'

type RuntimeMobileAgentStatusHost = {
  getPaneKey(tab: RuntimeMobileSessionTerminalTab): string
  getLeaf(tab: RuntimeMobileSessionTerminalTab): RuntimeLeafRecord | null
  getTrackedTitle(ptyId: string | null): string | null
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
  // Why: neither the OSC-retained row nor a title-derived status can carry a
  // provider session — only the hook payload does, and headless serve has no
  // renderer to publish `tab.agentStatus`. Without it mobile native chat has no
  // transcript to address and sits on the empty state forever.
  const hookRow = selectRuntimeHookAgentRowForPane(getHookRowsForPane(paneKey))
  // Why: the hook row is evidence in its own right. Returning early on a missing
  // PTY status/retained row put this check ahead of the only headless carrier, so
  // an agent that reported its session but never emitted a recognized title got no
  // `agentStatus` at all — exactly the hook-only case the fallback exists for.
  if (!pty?.lastAgentStatus && !retained && !hookRow.agentType && !hookRow.providerSession) {
    return {}
  }
  const providerSession = hookRow.providerSession
    ? { providerSession: hookRow.providerSession }
    : {}
  const leaf = host.getLeaf(tab)
  const trackerOnlyTitle = host.getTrackedTitle(pty?.ptyId ?? leaf?.ptyId ?? null)
  const ptyTitle = pty
    ? getLatestAgentCandidateTitle(
        { title: pty.title, updatedAt: pty.titleUpdatedAt },
        { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
      )
    : leaf
      ? getLatestAgentCandidateTitle(
          { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
          { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
        )
      : null
  const ptyTitleClassification = classifyAgentTitle(ptyTitle)
  const nonAgentTitle = ptyTitle !== null && ptyTitleClassification !== 'agent'
  if (nonAgentTitle) {
    // Why: non-agent title = shell reclaimed the pane; suppress to clear stuck spinners (#1437), though a live hook signal survives.
    const hasLiveHookSignal =
      retained?.payload.interactivePrompt != null ||
      retained?.payload.toolName != null ||
      // Why: a pending question is never inherited across hook events (unlike
      // `toolName`), so it proves the agent is parked on a selector right now.
      hookRow.live?.payload.interactivePrompt != null ||
      // Why: headless serve has no renderer to retain an OSC row, so a fresh hook
      // agentType is the only live signal a hook-only pane can offer — and an agent
      // that reports over HTTP need never set a title this gate would recognize.
      // Scoped to panes with no PTY status at all, so it cannot revive a spinner:
      // this branch publishes `done`. It only keeps the transcript addressable.
      (!pty?.lastAgentStatus && (hookRow.agentType != null || hookRow.providerSession != null))
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
  // Why: OSC 9999 hook payload carries real state/prompt/agent; without preferring it, hook-only transitions never surfaced (#7970).
  const liveRow = retained ?? resolveRuntimeHookLiveAgentRow(hookRow.live, pty, nonAgentTitle)
  if (liveRow) {
    const liveStatus = normalizeCompatibleAgentStatusEntryForOwner(
      {
        ...liveRow.payload,
        paneKey,
        updatedAt: liveRow.updatedAt,
        stateStartedAt: liveRow.stateStartedAt,
        stateHistory: [],
        ...(terminalHandle ? { terminalHandle } : {}),
        ...((pty?.worktreeId ?? liveRow.worktreeId)
          ? { worktreeId: pty?.worktreeId ?? liveRow.worktreeId }
          : {}),
        tabId: tab.parentTabId,
        terminalTitle,
        ...providerSession
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
  // Last resort: the pane's hook evidence is identity only (resume rows, stale
  // rows, or a row the freshness gate rejected). `done` is the honest
  // projection — and it is what retires the card once the agent exits.
  // Why not lastOutputAt: this state is title-derived, so it must be dated by
  // its evidence. Stamping it with the byte stream made the frame advance on
  // every output byte, so a paired client's live status could never outrank it.
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
