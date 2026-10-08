// The runtime's answer to "what is this agent called", from its own records, for any send that
// speaks for another agent: the mail lane today, a dispatched task next.

import type { AgentMessageSender } from '../../shared/agent-session-message-source'
import type { AgentType } from '../../shared/agent-status-types'
import type { Tab } from '../../shared/tab-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { OrchestrationDb } from './orchestration/db'
import {
  orchestrationSenderName,
  type TerminalSenderNaming
} from './orchestration/orchestration-sender-name'
import { agentMessageSender } from './orchestration/agent-message-sender'
import { readAgentSessionRecordStore } from './orchestration/structured-session-lineage'

type RuntimeSenderNameDeps = {
  getDb: () => OrchestrationDb | null
  getHandleRecord: (
    handle: string
  ) => { worktreeId: string; tabId: string; ptyId: string | null } | undefined
  getPtyAgents: (
    ptyId: string
  ) => { launchAgent?: AgentType | null; foregroundAgent?: AgentType | null } | undefined
  getTerminalPaneKey: (handle: string) => string | null
  /** The workspace session this host mirrors, of which only the tabs are read. */
  getWorkspaceSession: (worktreeId: string) => MirroredTabs | null | undefined
}

type MirroredTabs = {
  unifiedTabs?: Readonly<
    Record<string, readonly Pick<Tab, 'contentType' | 'entityId' | 'customLabel' | 'label'>[]>
  >
  tabsByWorktree?: Readonly<Record<string, readonly Pick<TerminalTab, 'id' | 'customTitle'>[]>>
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
        terminal: (handle) => this.terminalNaming(handle)
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
    const tab = this.deps
      .getWorkspaceSession(record.worktreeId)
      ?.tabsByWorktree?.[record.worktreeId]?.find((candidate) => candidate.id === record.tabId)
    return {
      customTitle: tab?.customTitle ?? null,
      agent: pty?.launchAgent ?? pty?.foregroundAgent ?? null,
      paneKey: this.deps.getTerminalPaneKey(handle)
    }
  }
}
