import type { AgentType } from '../../../shared/agent-status-types'
import { leafIdsOf } from '../../../shared/workspace-layout/workspace-layout-command-steps'
import type { WorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-model'
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import { setTerminalTabsToChats } from '../../../shared/workspace-layout/workspace-layout-tab-content'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../../persistence/restoring-sessions/workspace-session-write-rollback'
import type { RuntimeStore } from '../runtime-store-contract'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'

/** A chat main's record names a tab for: the visible chats of one workspace at a cold load. */
export type RecordedChatTab = { sessionId: string; agent: AgentType; tabId: string }

/**
 * A cold load's repair of the saved layout against main's chat records, decided once before any
 * terminal of this load runs. A switch records its chat's tab before that tab's own write, so a
 * crash between the two restarts with the recorded tab still holding the stopped terminal: when no
 * process holds that terminal (`liveness` false for each of its saved PTYs), the tab takes the
 * chat in place (`replace`). A tab holding anything else, a split, or a terminal whose process may
 * still run (true, or null: unknown) keeps what it holds, and the chat's record moves to a free tab
 * (`move`), where the ordinary restore opens it.
 */
export function restoredSwitchPlan(
  workspace: WorkspaceLayout | undefined,
  recorded: readonly RecordedChatTab[],
  liveness: (ptyId: string) => boolean | null
): {
  replace: { tabId: string; terminalId: string; sessionId: string; agent: AgentType }[]
  move: { sessionId: string; tabId: string }[]
} {
  const replace: ReturnType<typeof restoredSwitchPlan>['replace'] = []
  const move: ReturnType<typeof restoredSwitchPlan>['move'] = []
  if (!workspace) {
    return { replace, move }
  }
  const byId = new Map(workspace.tabs.map((tab) => [tab.id, tab]))
  const shown = new Set(
    workspace.tabs.flatMap((tab) => (tab.kind === 'agent-session' ? [tab.entityId] : []))
  )
  const taken = new Set(byId.keys())
  for (const chat of recorded) {
    const tab = byId.get(chat.tabId)
    if (!tab || shown.has(chat.sessionId) || tab.entityId === chat.sessionId) {
      continue
    }
    const leaves = tab.kind === 'terminal' ? leafIdsOf(tab) : []
    const ptyId = leaves.length === 1 ? workspace.leaves?.[leaves[0]!]?.ptyId : undefined
    if (tab.kind === 'terminal' && leaves.length === 1 && (!ptyId || liveness(ptyId) === false)) {
      replace.push({ ...chat, terminalId: tab.entityId })
      shown.add(chat.sessionId)
      continue
    }
    const preferred = structuredAgentSessionTabId(chat.sessionId)
    let tabId = preferred
    for (let suffix = 2; taken.has(tabId); suffix++) {
      tabId = `${preferred}-${suffix}`
    }
    taken.add(tabId)
    move.push({ sessionId: chat.sessionId, tabId })
  }
  return { replace, move }
}

export type RestoredSwitchRepairPorts = {
  hostId: ExecutionHostId
  store: Required<
    Pick<RuntimeStore, 'getWorkspaceSession' | 'setWorkspaceSession' | 'runDurableMutation'>
  >
  host: Pick<
    StructuredAgentSessionHost,
    'listSessionTabs' | 'getSessionTabId' | 'getSessionTabGeneration' | 'setSessionTabVisibility'
  >
  /** The startup census's live PTYs; null when it could not answer (every terminal kept). */
  live: ReadonlySet<string> | null
  /** Only the host's own workspaces: a paired host's mirrored partitions are never repaired here. */
  ownsWorkspace: (worktreeId: string) => boolean
}

/**
 * The cold load's one repair of the saved tabs against main's chat records (see
 * `restoredSwitchPlan`): the replacements are one checked saved patch, written before anything
 * shows them, and each kept tab's chat record then moves to its free tab while that record is
 * still the one this read. Answers the workspaces whose saved tabs changed.
 */
export async function repairRestoredSwitches(ports: RestoredSwitchRepairPorts): Promise<string[]> {
  const { hostId, store, host, live } = ports
  const recorded = new Map<string, (RecordedChatTab & { generation: number })[]>()
  for (const chat of host.listSessionTabs()) {
    const tabId = host.getSessionTabId(chat.sessionId)
    if (tabId && ports.ownsWorkspace(chat.workspaceId)) {
      const generation = host.getSessionTabGeneration(chat.sessionId)
      const chats = recorded.get(chat.workspaceId) ?? []
      chats.push({ sessionId: chat.sessionId, agent: chat.agent, tabId, generation })
      recorded.set(chat.workspaceId, chats)
    }
  }
  // Only a record naming a tab that holds something else needs the layout: a load no switch
  // crashed (every chat in its own tab) reads nothing more and queues no write.
  const saved = store.getWorkspaceSession(hostId)
  const conflicts = [...recorded].some(([worktreeId, chats]) => {
    const held = new Map(
      (saved?.unifiedTabs?.[worktreeId] ?? []).map((tab) => [tab.id, tab.entityId] as const)
    )
    const terminals = new Set((saved?.tabsByWorktree[worktreeId] ?? []).map((row) => row.id))
    return chats.some(
      (chat) =>
        terminals.has(chat.tabId) ||
        (held.has(chat.tabId) && held.get(chat.tabId) !== chat.sessionId)
    )
  })
  if (!conflicts) {
    return []
  }
  const liveness = (ptyId: string): boolean | null => (live ? live.has(ptyId) : null)
  const changed: string[] = []
  const moves: (ReturnType<typeof restoredSwitchPlan>['move'][number] & { generation: number })[] =
    []
  await store.runDurableMutation(() => {
    const session = store.getWorkspaceSession(hostId)
    if (!session) {
      return { value: undefined, persist: false }
    }
    const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
    let layout = loaded.layout
    for (const [worktreeId, chats] of recorded) {
      const plan = restoredSwitchPlan(layout.workspaces[worktreeId], chats, liveness)
      const generations = new Map(chats.map((chat) => [chat.sessionId, chat.generation]))
      moves.push(
        ...plan.move.map((move) => ({ ...move, generation: generations.get(move.sessionId)! }))
      )
      if (plan.replace.length > 0) {
        layout = setTerminalTabsToChats(layout, worktreeId, plan.replace, Date.now())
        changed.push(worktreeId)
      }
    }
    if (layout === loaded.layout) {
      return { value: undefined, persist: false }
    }
    const next = saveWorkspaceLayout({ ...loaded, layout })
    store.setWorkspaceSession(next, hostId)
    return {
      value: undefined,
      rollback: () => {
        const current = store.getWorkspaceSession(hostId)
        if (current) {
          store.setWorkspaceSession(
            rollbackWorkspaceSessionAfterFailedAsyncWrite(session, next, current),
            hostId
          )
        }
      }
    }
  })
  for (const { sessionId, tabId, generation } of moves) {
    await host.setSessionTabVisibility(sessionId, true, tabId, {
      move: true,
      check: () => {
        if (host.getSessionTabGeneration(sessionId) !== generation) {
          throw new Error('Chat tab record changed since the restart repair read it')
        }
      }
    })
  }
  return changed
}

/** The local host's repair at startup; a host or store that can't take it changes nothing. */
export function repairRestoredSwitchesAtStartup(
  store: RuntimeStore | null | undefined,
  host: StructuredAgentSessionHost | null | undefined,
  live: ReadonlySet<string> | null,
  ownsWorkspace: (worktreeId: string) => boolean
): Promise<string[]> {
  if (
    !host ||
    !store?.getWorkspaceSession ||
    !store.setWorkspaceSession ||
    !store.runDurableMutation
  ) {
    return Promise.resolve([])
  }
  return repairRestoredSwitches({
    hostId: LOCAL_EXECUTION_HOST_ID,
    store: {
      getWorkspaceSession: store.getWorkspaceSession.bind(store),
      setWorkspaceSession: store.setWorkspaceSession.bind(store),
      runDurableMutation: store.runDurableMutation.bind(store)
    },
    host,
    live,
    ownsWorkspace
  }).catch((error: unknown) => {
    // Nothing repaired is the ordinary restore: every tab keeps what it saved.
    host.deps.logger.warn('repairing restored switched tabs failed', {
      scope: 'restored-switch-repair',
      error
    })
    return []
  })
}
