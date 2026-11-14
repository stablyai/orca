import type {
  AgentConversationRow,
  AgentListResult,
  AgentListState,
  AgentShowResult
} from '../../../shared/agent-conversations/agent-conversation-contracts'
import {
  SAVED_WITHOUT_DISTRO,
  sleepingRecordSighting
} from '../../agent-hooks/identity/sleeping-agent-records'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeWorktreePsResult } from '../../../shared/runtime-worktree-contracts'
import { structuredAgentSessionIdFromTabId } from '../../../shared/agent-session/view/structured-agent-session-tab-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/agent-session/view/structured-agent-session-projection'
import { resolveLineageRunningSession } from '../orchestration/addressing/session-lineage/structured-session-lineage'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import type { ResolvedAgentConversation } from './agent-conversation-address'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { RuntimeOrchestrationSenderNames } from '../orchestration/mailbox/senders/runtime-orchestration-sender-names'
import { connectionEvidenceHostId } from '../workspaces/process-listing/runtime-worktree-summary-paths'

type ListFilter = { worktreeId?: string; state?: AgentListState }

type AgentPlaceRuntime = {
  getWorkspaceLabel(
    worktreeId: string,
    hostId: ExecutionHostId
  ): { workspace: string; repo?: string } | null
  readLocalSleepingAgentSessions(): Readonly<Record<string, SleepingAgentSessionRecord>>
  /** Names a saved pane as a live row is named: its saved tab's names, then its own title. */
  orchestrationSenderNames: Pick<RuntimeOrchestrationSenderNames, 'agentRowNamer'>
}

type PaneNamer = ReturnType<RuntimeOrchestrationSenderNames['agentRowNamer']>

/** Every agent in this host's workspaces: `worktree.ps` rows, then each terminal agent with no
 *  open pane from its saved sleeping record (asleep, or its tab not reopened since a wake), so
 *  a list never wakes one. Filters run before any record's id or label: beyond `worktree.ps`, a
 *  list visits the saved records of its workspace only when it can show asleep rows, and
 *  otherwise only the records of its own reply-less rows' panes, by key. Ids are asked only
 *  for keys this store authority has not answered. */
export async function listAgentConversations(
  runtime: AgentPlaceRuntime & {
    getWorktreePs(limit: number): Promise<RuntimeWorktreePsResult>
  },
  worktreeLimit: number,
  filter: ListFilter = {}
): Promise<AgentListResult> {
  // Every state's rows: a pane open in any state is not asleep.
  const list = projectAgentConversationList(
    await runtime.getWorktreePs(worktreeLimit),
    filter.worktreeId ? { worktreeId: filter.worktreeId } : {}
  )
  const shown = list.agents.filter((row) => !filter.state || row.state === filter.state)
  const saved = runtime.readLocalSleepingAgentSessions()
  // A woken agent's row before its first new reply: its pane's saved record holds the last one.
  const borrowing = shown.flatMap((row) => {
    const record = row.orcaSessionId && !row.lastAssistantMessage ? saved[row.paneKey] : undefined
    return record ? [{ row, record }] : []
  })
  const open = new Set(list.agents.map((row) => row.paneKey))
  const candidates =
    !filter.state || filter.state === 'asleep'
      ? Object.values(saved).filter(
          (record) =>
            !open.has(record.paneKey) &&
            (!filter.worktreeId || record.worktreeId === filter.worktreeId)
        )
      : []
  const records = [...borrowing.map(({ record }) => record), ...candidates]
  const ids = await agentHookServer.sleepingTerminalAgentIds(saved, records)
  borrowing.forEach(({ row, record }, index) => {
    if (ids[index] === row.orcaSessionId) {
      row.lastAssistantMessage = record.lastAssistantMessage ?? null
    }
  })
  const listed = new Set(list.agents.map((row) => row.orcaSessionId))
  const asleep: AgentConversationRow[] = []
  // One namer per list: it resolves each workspace's saved tabs once.
  const name = candidates.length > 0 ? runtime.orchestrationSenderNames.agentRowNamer() : null
  candidates.forEach((record, index) => {
    const orcaSessionId = ids[borrowing.length + index] ?? null
    if (orcaSessionId && listed.has(orcaSessionId)) {
      return
    }
    listed.add(orcaSessionId)
    const place = sleepingPlace(runtime, record, orcaSessionId, name!)
    if (place) {
      asleep.push(place)
    }
  })
  asleep.sort((a, b) => a.updatedAt - b.updatedAt)
  return { ...list, agents: [...shown, ...asleep] }
}

/** A terminal agent's saved sleeping record as a listed place; none for a workspace this host
 *  no longer has. */
function sleepingPlace(
  runtime: AgentPlaceRuntime,
  record: SleepingAgentSessionRecord,
  orcaSessionId: string | null,
  name: PaneNamer
): AgentConversationRow | null {
  const hostId = connectionEvidenceHostId(record.connectionId ?? null)
  const label = runtime.getWorkspaceLabel(record.worktreeId, hostId)
  const tabId = record.tabId ?? parsePaneKey(record.paneKey)?.tabId
  // Visible, but its ID can't be found until it wakes and names its distro again.
  const savedWithoutDistro =
    !orcaSessionId && sleepingRecordSighting(record, process.platform === 'win32') === null
  return label
    ? {
        orcaSessionId,
        ...(savedWithoutDistro ? { savedWithoutDistro } : {}),
        kind: 'terminal',
        agent: record.agent,
        state: 'asleep',
        worktreeId: record.worktreeId,
        ...label,
        hostId,
        paneKey: record.paneKey,
        // A split pane takes only its own saved title, never a focused sibling's.
        title:
          (tabId &&
            name({
              paneKey: record.paneKey,
              tabId,
              worktreeId: record.worktreeId,
              ptyId: undefined,
              agentType: record.agent,
              providerSessionId: record.providerSession.id
            })) ||
          record.terminalTitle ||
          null,
        lastAssistantMessage: record.lastAssistantMessage ?? null,
        updatedAt: record.updatedAt
      }
    : null
}

/** `worktree.ps` agent rows as one flat list of chats and terminal agents, oldest state first. */
export function projectAgentConversationList(
  ps: RuntimeWorktreePsResult,
  filter: ListFilter = {}
): AgentListResult {
  const agents: AgentConversationRow[] = []
  for (const worktree of ps.worktrees) {
    if (filter.worktreeId && worktree.worktreeId !== filter.worktreeId) {
      continue
    }
    for (const row of worktree.agents) {
      if (filter.state && row.state !== filter.state) {
        continue
      }
      agents.push({
        orcaSessionId: row.orcaSessionId ?? null,
        // A chat's pane key leads with its tab id.
        kind: structuredAgentSessionIdFromTabId(row.paneKey) === null ? 'terminal' : 'chat',
        agent: row.agentType,
        state: row.state,
        worktreeId: worktree.worktreeId,
        workspace: worktree.displayName,
        ...(worktree.repo && worktree.workspaceKind !== 'folder-workspace'
          ? { repo: worktree.repo }
          : {}),
        ...(worktree.hostId ? { hostId: worktree.hostId } : {}),
        paneKey: row.paneKey,
        title: row.conversationName ?? row.displayName ?? row.taskTitle,
        lastAssistantMessage: row.lastAssistantMessage,
        updatedAt: row.updatedAt
      })
    }
  }
  return {
    agents,
    truncated: ps.truncated,
    ...(ps.hostScope ? { hostScope: ps.hostScope } : {})
  }
}

/** Where one resolved conversation is open now, from its own keyed status rows: never a listing
 *  of every workspace. A closed chat has none; a terminal agent with no live pane shows the
 *  saved sleeping record naming its conversation, as `agent list` does. */
export async function agentConversationPlaces(
  runtime: AgentPlaceRuntime,
  resolved: ResolvedAgentConversation
): Promise<AgentConversationRow[]> {
  return (await conversationPlaces(runtime, resolved)).places
}

/** `agent show`: the places, and why a sleeping WSL agent saved without its distro has none. */
export async function showAgentConversation(
  runtime: AgentPlaceRuntime,
  resolved: ResolvedAgentConversation
): Promise<AgentShowResult> {
  const { places, savedWithoutDistro } = await conversationPlaces(runtime, resolved)
  return {
    orcaSessionId: resolved.orcaSessionId,
    kind: resolved.kind,
    places,
    ...(savedWithoutDistro ? { savedWithoutDistro } : {})
  }
}

async function conversationPlaces(
  runtime: AgentPlaceRuntime,
  resolved: ResolvedAgentConversation
): Promise<{ places: AgentConversationRow[]; savedWithoutDistro?: true }> {
  const places = await openPlaces(runtime, resolved)
  if (places.length > 0 || resolved.kind !== 'terminal') {
    return { places }
  }
  const sleeping = await agentHookServer.sleepingTerminalAgent(resolved.orcaSessionId, () =>
    runtime.readLocalSleepingAgentSessions()
  )
  if (sleeping === SAVED_WITHOUT_DISTRO) {
    return { places: [], savedWithoutDistro: true }
  }
  const place =
    typeof sleeping === 'object' && sleeping && 'record' in sleeping
      ? sleepingPlace(
          runtime,
          sleeping.record,
          resolved.orcaSessionId,
          runtime.orchestrationSenderNames.agentRowNamer()
        )
      : null
  return { places: place ? [place] : [] }
}

async function openPlaces(
  runtime: AgentPlaceRuntime,
  resolved: ResolvedAgentConversation
): Promise<AgentConversationRow[]> {
  const { orcaSessionId } = resolved
  let paneKeys: string[]
  if (resolved.kind === 'chat') {
    // A chat's status row is keyed by the session that runs its conversation now.
    const running = resolveLineageRunningSession(resolved.store, resolved.record.sessionId)
    paneKeys =
      running.kind === 'here'
        ? [
            structuredAgentSessionPaneKey(
              structuredAgentSessionTabId(running.sessionId),
              running.sessionId
            )
          ]
        : []
  } else {
    paneKeys = ((await agentHookServer.terminalAgentPlaces(orcaSessionId)) ?? []).map(
      (place) => place.paneKey
    )
  }
  return paneKeys.flatMap((paneKey) =>
    agentHookServer.getPublicStatusSnapshotForPane(paneKey).flatMap((status) => {
      const { worktreeId } = status
      const ours =
        resolved.kind === 'chat'
          ? status.structuredHost !== undefined
          : status.orcaSessionId === orcaSessionId
      // The place's own host, from the row's connection evidence, so a same-id workspace on
      // another host never lends its name.
      const hostId = connectionEvidenceHostId(status.connectionId)
      return worktreeId && ours
        ? [
            {
              orcaSessionId,
              kind: resolved.kind,
              agent: status.agentType ?? null,
              state: status.state,
              worktreeId,
              ...(runtime.getWorkspaceLabel(worktreeId, hostId) ?? { workspace: worktreeId }),
              hostId,
              paneKey: status.paneKey,
              title: null,
              lastAssistantMessage: status.lastAssistantMessage ?? null,
              updatedAt: status.evidenceObservedAt ?? status.receivedAt
            }
          ]
        : []
    })
  )
}
