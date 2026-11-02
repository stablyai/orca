// Name another agent from host records when sending on its behalf or listing its worktree.ps row.

import type { AgentMessageSender } from '../../shared/agent-session/agent-session-message-source'
import {
  getAgentRowConversationName,
  type ConversationNameTab
} from '../../shared/agent-row-conversation-name'
import type { AgentType } from '../../shared/agent-status-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { structuredAgentSessionIdFromTabId } from '../../shared/structured-agent-session-tab-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../shared/terminal-tab-types'
import type { OrchestrationDb } from './orchestration/db'
import {
  observeOrchestrationSender,
  orchestrationSenderAgent,
  orchestrationSenderName,
  structuredChatNaming,
  captureMirroredTabs,
  type MirroredTabs,
  type SenderHookRow,
  type SenderNamingSources,
  type TerminalSenderNaming
} from './orchestration/orchestration-sender-name'
import { agentMessageSender, type SenderSnapshot } from './orchestration/agent-message-sender'
import {
  type AgentSessionRecordReader,
  readAgentSessionRecordStore
} from './orchestration/structured-session-lineage'
import { terminalHostConnectionMatches } from './orchestration/worker-provider-session'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

type RuntimeSenderNameDeps = {
  getDb: () => OrchestrationDb | null
  getHandleRecord: (
    handle: string
  ) => { worktreeId: string; tabId: string; ptyId: string | null } | undefined
  getPtyAgents: (ptyId: string) =>
    | {
        launchAgent?: AgentType | null
        foregroundAgent?: AgentType | null
        connectionId?: string | null
        wslDistro?: string | null
        launchToken?: string | null
      }
    | undefined
  getTerminalPaneKey: (handle: string) => string | null
  /** The workspace session this host mirrors. */
  getWorkspaceSession: (worktreeId: string) => MirroredTabs | null | undefined
  /** The person's "generate tab titles" setting, which decides whether a generated title names a tab. */
  getGeneratedTitlesEnabled: () => boolean
  getAgentStatusSnapshotForPane: (paneKey: string) => readonly SenderHookRow[] | undefined
  getAgentStatusSnapshot?: () => readonly SenderHookRow[]
  getTrackedTitle: (ptyId: string) => string | null
}

type SessionLookup = RuntimeSenderNameDeps['getWorkspaceSession']

type AgentRowNamingSource = Pick<
  RuntimeWorktreeAgentSource,
  'paneKey' | 'tabId' | 'worktreeId' | 'ptyId' | 'agentType' | 'providerSessionId'
>

export class RuntimeOrchestrationSenderNames {
  constructor(private readonly deps: RuntimeSenderNameDeps) {}

  /** A sender recorded on a message, named now. `reportedDispatchId`: the dispatch the sender's
   *  own `worker_done` in that message names. */
  sender(address: string, reportedDispatchId?: string): AgentMessageSender {
    return agentMessageSender(
      address,
      this.deps.getDb(),
      (party, reported) => this.snapshotOf(party, reported),
      reportedDispatchId
    )
  }

  nameOf(
    party: AgentMessageSender['party'],
    reportedDispatchId?: string,
    taskName?: string | null,
    records: AgentSessionRecordReader | null = readAgentSessionRecordStore()
  ): string | null {
    return orchestrationSenderName(
      party,
      this.namingSources(records),
      reportedDispatchId,
      undefined,
      taskName
    )
  }

  /** Name and agent share one current chat or terminal observation. */
  snapshotOf(party: AgentMessageSender['party'], reportedDispatchId?: string): SenderSnapshot {
    const sources = this.namingSources()
    const observation = observeOrchestrationSender(party, sources, reportedDispatchId)
    return {
      name: orchestrationSenderName(party, sources, reportedDispatchId, observation),
      agent: orchestrationSenderAgent(sources, observation)
    }
  }

  private namingSources(
    records: AgentSessionRecordReader | null = readAgentSessionRecordStore()
  ): SenderNamingSources {
    const terminals = new Map<string, TerminalSenderNaming | null>()
    return {
      ...this.chatSources(undefined, records),
      db: this.deps.getDb(),
      terminal: (handle) => {
        if (!terminals.has(handle)) {
          terminals.set(handle, this.terminalNaming(handle))
        }
        return terminals.get(handle) ?? null
      },
      generatedTitlesEnabled: this.deps.getGeneratedTitlesEnabled()
    }
  }

  /** Names one worktree.ps pass's rows as desktop's compact row does; null keeps the phone's message fallback. */
  agentRowNamer(): (source: AgentRowNamingSource) => string | null {
    // A pass reads the setting and each worktree's session at most once, however many rows it lists.
    let generatedTitlesEnabled: boolean | undefined
    const sessions = new Map<string, MirroredTabs | null | undefined>()
    const session: SessionLookup = (worktreeId) => {
      if (!sessions.has(worktreeId)) {
        sessions.set(worktreeId, this.deps.getWorkspaceSession(worktreeId))
      }
      return sessions.get(worktreeId)
    }
    const chatSources = this.chatSources(session)
    return (source) => {
      const { tabId, worktreeId } = source
      if (!tabId || !worktreeId) {
        return null
      }
      const chatSessionId = structuredAgentSessionIdFromTabId(tabId)
      if (chatSessionId !== null) {
        const chat = structuredChatNaming(chatSessionId, chatSources)
        return chat ? chat.ownName || chat.fallback : null
      }
      const record = { worktreeId, tabId, ptyId: source.ptyId ?? null }
      const pane = this.paneNaming(record, source.paneKey, session)
      generatedTitlesEnabled ??= this.deps.getGeneratedTitlesEnabled()
      return pane.tab
        ? getAgentRowConversationName(
            pane.tab,
            source.agentType,
            generatedTitlesEnabled,
            pane.paneTitle,
            source.providerSessionId
          )
        : null
    }
  }

  captureCrewInputs() {
    const generatedTitlesEnabled = this.deps.getGeneratedTitlesEnabled()
    const db = this.deps.getDb()
    const tabs = captureMirroredTabs((id) => this.deps.getWorkspaceSession(id))
    const statuses = new Map<string, SenderHookRow[]>()
    const allStatuses = this.deps.getAgentStatusSnapshot?.()
    for (const row of allStatuses ?? []) {
      const rows = statuses.get(row.paneKey) ?? []
      rows.push(structuredClone(row))
      statuses.set(row.paneKey, rows)
    }
    const terminals = new Map<string, TerminalSenderNaming | null>()
    return (
      party: AgentMessageSender['party'],
      taskName: string | null,
      records: AgentSessionRecordReader | null,
      readPane = this.deps.getTerminalPaneKey
    ) =>
      orchestrationSenderName(
        party,
        {
          db,
          records,
          generatedTitlesEnabled,
          chatTab: tabs.chatTab,
          terminal: (handle) => {
            if (!terminals.has(handle)) {
              const naming = this.terminalNaming(
                handle,
                tabs.session,
                tabs.terminalTab,
                allStatuses ? (pane) => statuses.get(pane) ?? [] : this.statusRowsForPane,
                readPane
              )
              terminals.set(handle, naming ? structuredClone(naming) : null)
            }
            return terminals.get(handle) ?? null
          }
        },
        undefined,
        undefined,
        taskName
      )
  }

  private chatSources(
    session: SessionLookup = this.deps.getWorkspaceSession,
    records: AgentSessionRecordReader | null = readAgentSessionRecordStore()
  ): Pick<SenderNamingSources, 'records' | 'chatTab'> {
    return {
      records,
      chatTab: (worktreeId, sessionId) =>
        session(worktreeId)?.unifiedTabs?.[worktreeId]?.find(
          (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
        ) ?? null
    }
  }

  private statusRowsForPane = (pane: string): readonly SenderHookRow[] =>
    this.deps.getAgentStatusSnapshotForPane(pane) ??
    this.deps.getAgentStatusSnapshot?.().filter((row) => row.paneKey === pane) ??
    []

  private terminalNaming(
    handle: string,
    readSession = this.deps.getWorkspaceSession,
    readTab?: (
      worktreeId: string,
      tabId: string
    ) => (Pick<TerminalTab, 'id'> & Partial<ConversationNameTab>) | undefined,
    readStatuses = this.statusRowsForPane,
    readPane = this.deps.getTerminalPaneKey
  ): TerminalSenderNaming | null {
    const record = this.deps.getHandleRecord(handle)
    if (!record) {
      return null
    }
    const pty = record.ptyId ? this.deps.getPtyAgents(record.ptyId) : undefined
    const session = readSession(record.worktreeId)
    const tab = readTab
      ? readTab(record.worktreeId, record.tabId)
      : session?.tabsByWorktree?.[record.worktreeId]?.find(
          (candidate) => candidate.id === record.tabId
        )
    const paneKey = readPane(handle)
    const status = paneKey
      ? readStatuses(paneKey)
          .filter(
            (row) =>
              row.paneKey === paneKey &&
              (!row.worktreeId || row.worktreeId === record.worktreeId) &&
              terminalHostConnectionMatches(row.connectionId, pty?.connectionId, pty?.wslDistro) &&
              (!pty?.launchToken || row.launchToken === pty.launchToken)
          )
          .sort((left, right) => right.receivedAt - left.receivedAt)[0]
      : undefined
    return {
      ...this.paneNaming(
        record,
        paneKey,
        () => session,
        () => tab
      ),
      agent: status?.agentType ?? pty?.launchAgent ?? pty?.foregroundAgent ?? null,
      providerSessionId: status?.providerSession?.id,
      paneKey
    }
  }

  /** The pane's mirrored tab and its own live title. */
  private paneNaming(
    record: { worktreeId: string; tabId: string; ptyId: string | null },
    paneKey: string | null,
    sessionOf: SessionLookup = this.deps.getWorkspaceSession,
    readTab?: (
      worktreeId: string,
      tabId: string
    ) => (Pick<TerminalTab, 'id'> & Partial<ConversationNameTab>) | undefined
  ): Pick<TerminalSenderNaming, 'tab' | 'paneTitle'> {
    const session = sessionOf(record.worktreeId)
    const tab = readTab
      ? readTab(record.worktreeId, record.tabId)
      : session?.tabsByWorktree?.[record.worktreeId]?.find(
          (candidate) => candidate.id === record.tabId
        )
    const trackedTitle = record.ptyId ? this.deps.getTrackedTitle(record.ptyId) : null
    return {
      tab: tab ? { ...tab, title: tab.title ?? '', customTitle: tab.customTitle ?? null } : null,
      paneTitle:
        trackedTitle ?? splitPaneTitle(session?.terminalLayoutsByTabId?.[record.tabId], paneKey)
    }
  }
}

/** Split-tab titles name the focused pane; other split panes need user titles. Single-pane tabs use their own tab titles. */
function splitPaneTitle(
  layout: Pick<TerminalLayoutSnapshot, 'root' | 'titlesByLeafId'> | undefined,
  paneKey: string | null
): string | null | undefined {
  if (layout?.root?.type !== 'split') {
    return undefined
  }
  const leafId = paneKey ? parsePaneKey(paneKey)?.leafId : undefined
  return (leafId && layout.titlesByLeafId?.[leafId]) || null
}
