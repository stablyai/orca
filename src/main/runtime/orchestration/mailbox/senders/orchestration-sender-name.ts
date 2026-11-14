import { senderDispatchLaunch } from './sender-dispatch-launch'
import { readWorkerTerminalHostScope } from '../../../../../shared/orchestration/workers/worker-terminal-host-scope'
import { crewDisplayName } from '../../crew/crew-rules'
import type { AgentMessageSender } from '../../../../../shared/agent-session/agent-session-message-source'
import { defaultAgentChatLabel } from '../../../../../shared/agent-session/agent-session-chat-label'
import {
  getAgentRowConversationName,
  type ConversationNameTab
} from '../../../../../shared/agent-status/presentation/agent-row-conversation-name'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { formatAgentTypeLabel } from '../../../../../shared/agent-status/presentation/agent-type-label'
import { structuredChatDisplayName } from '../../../../../shared/structured-chat-row-name'
import type { Tab } from '../../../../../shared/tab-types'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import {
  resolveLineageRunningSession,
  type AgentSessionRecordReader
} from '../../addressing/session-lineage/structured-session-lineage'
import { logWorkerLaunchObservationFailure } from '../../workers/launch/worker-launch-observation'

export type SenderHookRow = Pick<
  AgentStatusIpcPayload,
  | 'paneKey'
  | 'worktreeId'
  | 'agentType'
  | 'providerSession'
  | 'receivedAt'
  | 'connectionId'
  | 'launchToken'
>

export type MirroredTabs = {
  unifiedTabs?: Readonly<
    Record<string, readonly Pick<Tab, 'contentType' | 'entityId' | 'customLabel' | 'label'>[]>
  >
  tabsByWorktree?: Readonly<
    Record<string, readonly (Pick<TerminalTab, 'id'> & Partial<ConversationNameTab>)[]>
  >
  terminalLayoutsByTabId?: Readonly<
    Record<string, Pick<TerminalLayoutSnapshot, 'root' | 'titlesByLeafId'>>
  >
}

type MirroredTerminalTab = Pick<TerminalTab, 'id'> & Partial<ConversationNameTab>
type MirroredChatTab = Pick<Tab, 'contentType' | 'entityId' | 'customLabel' | 'label'>

export type SenderNamingLayout = {
  root: { type: 'leaf' | 'split' } | null
  titlesByLeafId?: Record<string, string>
}

export function terminalNameInputs(tab: MirroredTerminalTab): MirroredTerminalTab {
  const provider = tab.aiVaultTitle
  return {
    id: tab.id,
    title: tab.title,
    customTitle: tab.customTitle,
    quickCommandLabel: tab.quickCommandLabel,
    generatedTitle: tab.generatedTitle,
    defaultTitle: tab.defaultTitle,
    aiVaultTitle: provider
      ? {
          agent: provider.agent,
          sessionId: provider.sessionId,
          title: provider.title,
          ...(provider.kind ? { kind: provider.kind } : {})
        }
      : provider
  }
}

export function paneNamingTab(tab: MirroredTerminalTab | undefined, owned: boolean) {
  return tab
    ? {
        ...(owned ? terminalNameInputs(tab) : tab),
        title: tab.title ?? '',
        customTitle: tab.customTitle ?? null
      }
    : null
}

export function chatNameInputs(tab: MirroredChatTab): MirroredChatTab {
  return {
    contentType: tab.contentType,
    entityId: tab.entityId,
    customLabel: tab.customLabel,
    label: tab.label
  }
}

export function layoutNameInputs(layout: SenderNamingLayout): SenderNamingLayout {
  return {
    root: layout.root ? { type: layout.root.type } : null,
    titlesByLeafId: layout.titlesByLeafId ? { ...layout.titlesByLeafId } : undefined
  }
}

/** Capture naming values, never workspace buffers or editor drafts. */
export function captureMirroredTabs(
  read: (worktreeId: string) => MirroredTabs | null | undefined,
  isOwned: (worktreeId: string) => boolean = () => true
) {
  const workspaces = new Map<string, MirroredTabs | null>()
  const terminalTabs = new Map<string, Map<string, MirroredTerminalTab>>()
  const chatTabs = new Map<string, Map<string, MirroredChatTab>>()
  const layouts = new Map<string, SenderNamingLayout | undefined>()
  const session = (id: string) => {
    if (!workspaces.has(id)) {
      const live = read(id)
      if (!isOwned(id)) {
        workspaces.set(id, live ?? null)
        return live
      }
      const terminals = (live?.tabsByWorktree?.[id] ?? []).map(terminalNameInputs)
      const chats = (live?.unifiedTabs?.[id] ?? []).map(chatNameInputs)
      for (const tab of terminals) {
        const layout = live?.terminalLayoutsByTabId?.[tab.id]
        layouts.set(JSON.stringify([id, tab.id]), layout ? layoutNameInputs(layout) : undefined)
      }
      workspaces.set(
        id,
        live ? { tabsByWorktree: { [id]: terminals }, unifiedTabs: { [id]: chats } } : null
      )
      terminalTabs.set(id, new Map(terminals.toReversed().map((tab) => [tab.id, tab])))
      chatTabs.set(
        id,
        new Map(
          chats
            .filter((tab) => tab.contentType === 'agent-session')
            .toReversed()
            .map((tab) => [tab.entityId, tab])
        )
      )
    }
    return workspaces.get(id)
  }
  return {
    session,
    terminalTab: (worktreeId: string, tabId: string) =>
      isOwned(worktreeId)
        ? terminalTabs.get(worktreeId)?.get(tabId)
        : session(worktreeId)?.tabsByWorktree?.[worktreeId]?.find((tab) => tab.id === tabId),
    chatTab: (worktreeId: string, sessionId: string) => {
      session(worktreeId)
      return chatTabs.get(worktreeId)?.get(sessionId) ?? null
    },
    layout: (worktreeId: string, tabId: string) => {
      if (!isOwned(worktreeId)) {
        return session(worktreeId)?.terminalLayoutsByTabId?.[tabId]
      }
      const key = JSON.stringify([worktreeId, tabId])
      if (!layouts.has(key)) {
        const live = read(worktreeId)?.terminalLayoutsByTabId?.[tabId]
        layouts.set(key, live ? layoutNameInputs(live) : undefined)
      }
      return layouts.get(key)
    }
  }
}

export type TerminalSenderNaming = {
  /** The tab as this host mirrors the workspace session. */
  tab: ConversationNameTab | null
  /** Its current pane title; undefined lets a single pane use its mirrored tab title. */
  paneTitle?: string | null
  providerSessionId?: string
  agent: AgentType | null
  /** Its pane, which an active dispatch still names after the handle was reissued. */
  paneKey: string | null
  processIncarnation?: string | null
  hostScope?: string | null
}

export type SenderNamingSources = {
  db: OrchestrationDb | null
  records: AgentSessionRecordReader | null
  /** The chat's tab as this host mirrors the workspace session. */
  chatTab: (worktreeId: string, sessionId: string) => Pick<Tab, 'customLabel' | 'label'> | null
  terminal: (handle: string) => TerminalSenderNaming | null
  generatedTitlesEnabled: boolean
  dispatchLaunch?: (dispatch: DispatchContextRow) => AgentType | null
}

type Party = AgentMessageSender['party']

export type SenderObservation = {
  chat: ReturnType<typeof structuredChatNaming>
  terminal: TerminalSenderNaming | null
  dispatch: DispatchContextRow | null
}

/** Resolve nullable sources once; a missing observation is shared by both projections. */
export function observeOrchestrationSender(
  party: Party,
  sources: SenderNamingSources,
  reportedDispatchId?: string
): SenderObservation {
  const db = sources.db
  const dispatchId = party.address.startsWith('dispatch:') ? party.address.slice(9) : undefined
  const role = dispatchId ? db?.getDispatchContextById(dispatchId) : undefined
  const remote = dispatchId ? db?.getFederatedDispatch(dispatchId) : undefined
  const scope = readWorkerTerminalHostScope(role?.host_scope)
  const local = !remote && scope.kind !== 'remote' && scope.kind !== 'unreadable'
  const sessionId = !local ? null : (role?.assignee_orca_session_id ?? party.orcaSessionId)
  const chat = sessionId ? structuredChatNaming(sessionId, sources) : null
  const handle = !local ? null : (role?.assignee_handle ?? party.terminalHandle)
  const candidate = handle ? sources.terminal(handle) : null
  const terminal = role
    ? role.process_incarnation &&
      candidate?.processIncarnation === role.process_incarnation &&
      candidate.paneKey === role.assignee_pane_key &&
      (candidate.hostScope ?? null) === role.host_scope
      ? candidate
      : null
    : candidate
  let dispatch: DispatchContextRow | null | undefined = role
  return {
    chat,
    terminal,
    get dispatch() {
      if (dispatch === undefined) {
        dispatch =
          !db || !handle
            ? null
            : (db.getActiveDispatchForTerminal(handle, terminal?.paneKey ?? undefined) ??
              reportedDispatch(db, reportedDispatchId, handle, terminal?.paneKey ?? undefined) ??
              null)
      }
      return dispatch
    }
  }
}

/** `reportedDispatchId`: the dispatch the sender's own `worker_done` in the batch names. */
export function orchestrationSenderName(
  party: Party,
  sources: SenderNamingSources,
  reportedDispatchId?: string,
  observation = observeOrchestrationSender(party, sources, reportedDispatchId),
  taskName?: string | null
): string | null {
  const { chat, terminal } = observation
  const terminalName = terminal?.tab
    ? getAgentRowConversationName(
        terminal.tab,
        terminal.agent,
        sources.generatedTitlesEnabled,
        terminal.paneTitle,
        terminal.providerSessionId
      )
    : null
  const ownName = crewDisplayName(chat?.ownName, terminalName)
  if (ownName) {
    return ownName
  }
  return crewDisplayName(
    taskName !== undefined ? taskName : observedTaskName(observation, sources.db),
    chat?.fallback,
    terminal?.agent ? formatAgentTypeLabel(terminal.agent) : null
  )
}

function observedTaskName(
  observation: SenderObservation,
  db: OrchestrationDb | null
): string | null {
  const dispatch = observation.dispatch
  const task = dispatch ? db?.getTask(dispatch.task_id) : null
  return task?.display_name || task?.task_title || null
}

/** Current live kind wins; exact durable dispatch knowledge survives loss of live observations. */
export function orchestrationSenderAgent(
  sources: Pick<SenderNamingSources, 'db' | 'dispatchLaunch'>,
  observation: SenderObservation
): AgentType | null {
  const live = observation.chat?.agent || observation.terminal?.agent
  if (live) {
    return live
  }
  try {
    const dispatch = observation.dispatch
    return dispatch && sources.db
      ? (sources.dispatchLaunch ?? senderDispatchLaunch(sources.db))(dispatch)
      : null
  } catch (error) {
    logWorkerLaunchObservationFailure(error)
    return null
  }
}

/** A chat's own name (the person's rename, else its saved name) and the label its tab falls back to. */
export function structuredChatNaming(
  sessionId: string,
  sources: Pick<SenderNamingSources, 'records' | 'chatTab'>
): { ownName: string | null; fallback: string; agent: AgentType } | null {
  const running = resolveLineageRunningSession(sources.records, sessionId)
  const record = running.kind === 'here' ? running.record : null
  if (!record) {
    return null
  }
  const tab = sources.chatTab(record.location.workspaceId, record.sessionId)
  const fallback = tab?.label.trim() || defaultAgentChatLabel(record.provider)
  const ownName = structuredChatDisplayName(tab?.customLabel, record.conversationName, '') || null
  return { ownName, fallback, agent: record.provider }
}

/** Only the sender's own dispatch: a report's payload is the sender's to write. */
function reportedDispatch(
  db: OrchestrationDb,
  dispatchId: string | undefined,
  handle: string,
  paneKey: string | undefined
): DispatchContextRow | undefined {
  const dispatch = dispatchId ? db.getDispatchContextById(dispatchId) : undefined
  return dispatch &&
    (dispatch.assignee_handle === handle ||
      (paneKey !== undefined && dispatch.assignee_pane_key === paneKey))
    ? dispatch
    : undefined
}
