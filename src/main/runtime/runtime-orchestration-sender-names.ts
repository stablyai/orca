// The runtime's answer to "what is this agent called", from its own records, for any send that
// speaks for another agent: the mail lane today, a dispatched task next.

import type { AgentMessageSender } from '../../shared/agent-session-message-source'
import type { ConversationNameTab } from '../../shared/agent-row-conversation-name'
import type { AgentStatusIpcPayload, AgentType } from '../../shared/agent-status-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { Tab } from '../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../shared/terminal-tab-types'
import type { OrchestrationDb } from './orchestration/db'
import {
  orchestrationSenderName,
  type TerminalSenderNaming
} from './orchestration/orchestration-sender-name'
import { agentMessageSender } from './orchestration/agent-message-sender'
import { readAgentSessionRecordStore } from './orchestration/structured-session-lineage'
import { terminalHostConnectionMatches } from './orchestration/worker-provider-session'

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
  getAgentStatusSnapshotForPane: (paneKey: string) => readonly SenderHookRow[]
  getTrackedTitle: (ptyId: string) => string | null
}

type SenderHookRow = Pick<
  AgentStatusIpcPayload,
  | 'paneKey'
  | 'worktreeId'
  | 'agentType'
  | 'providerSession'
  | 'receivedAt'
  | 'connectionId'
  | 'launchToken'
>

type MirroredTabs = {
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

export class RuntimeOrchestrationSenderNames {
  constructor(private readonly deps: RuntimeSenderNameDeps) {}

  /** A sender recorded on a message, named now. `reportedDispatchId`: the dispatch the sender's
   *  own `worker_done` in that message names. */
  sender(address: string, reportedDispatchId?: string): AgentMessageSender {
    return agentMessageSender(
      address,
      this.deps.getDb(),
      (party, reported) => this.nameOf(party, reported),
      reportedDispatchId
    )
  }

  nameOf(party: AgentMessageSender['party'], reportedDispatchId?: string): string | null {
    return orchestrationSenderName(
      party,
      {
        db: this.deps.getDb(),
        records: readAgentSessionRecordStore(),
        chatTab: (worktreeId, sessionId) =>
          this.deps
            .getWorkspaceSession(worktreeId)
            ?.unifiedTabs?.[worktreeId]?.find(
              (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
            ) ?? null,
        terminal: (handle) => this.terminalNaming(handle),
        generatedTitlesEnabled: this.deps.getGeneratedTitlesEnabled()
      },
      reportedDispatchId
    )
  }

  private terminalNaming(handle: string): TerminalSenderNaming | null {
    const record = this.deps.getHandleRecord(handle)
    if (!record) {
      return null
    }
    const pty = record.ptyId ? this.deps.getPtyAgents(record.ptyId) : undefined
    const session = this.deps.getWorkspaceSession(record.worktreeId)
    const tab = session?.tabsByWorktree?.[record.worktreeId]?.find(
      (candidate) => candidate.id === record.tabId
    )
    const paneKey = this.deps.getTerminalPaneKey(handle)
    const status = paneKey
      ? this.deps
          .getAgentStatusSnapshotForPane(paneKey)
          .filter(
            (row) =>
              row.paneKey === paneKey &&
              (!row.worktreeId || row.worktreeId === record.worktreeId) &&
              terminalHostConnectionMatches(row.connectionId, pty?.connectionId, pty?.wslDistro) &&
              (!pty?.launchToken || row.launchToken === pty.launchToken)
          )
          .sort((left, right) => right.receivedAt - left.receivedAt)[0]
      : undefined
    const trackedTitle = record.ptyId ? this.deps.getTrackedTitle(record.ptyId) : null
    return {
      tab: tab ? { ...tab, title: tab.title ?? '', customTitle: tab.customTitle ?? null } : null,
      paneTitle:
        trackedTitle ?? splitPaneTitle(session?.terminalLayoutsByTabId?.[record.tabId], paneKey),
      agent: status?.agentType ?? pty?.launchAgent ?? pty?.foregroundAgent ?? null,
      providerSessionId: status?.providerSession?.id,
      paneKey
    }
  }
}

/** A split tab's title is its focused pane's, so a pane is named only by the title the person gave
 *  it; undefined for a single-pane tab, whose tab title is its own. */
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
