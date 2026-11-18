// A bots.chatTree row's own state (live, read) from the host's status rows, and the rows that are not
// native chats: terminal-only automation runs.
import type { AgentListVerdict } from '../../shared/agent-status/presentation/agent-list-status'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import { getAutomationRunLastRunAt } from '../../shared/automations/history/automation-run'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { automationRunDot } from '../../shared/bots/bot-activity-model'
import type { BotChatFacts } from '../../shared/bots/bot-chat-tree-model'

export function chatLive(row: AgentStatusIpcPayload | undefined): BotChatFacts['live'] {
  if (row?.state === 'blocked' || row?.state === 'waiting') {
    return 'needs-you'
  }
  return row?.state === 'working' ? 'replying' : 'idle'
}

/** Unread as the desktop window's Agents list says; a host without a window says nothing. */
export function chatReadUnread(verdict: AgentListVerdict | undefined): boolean {
  return verdict?.listed === true && verdict.unread
}

/** Automation runs with no chat of their own, each listed as a chat row like a run that has one. */
export function terminalRunChats(
  runs: readonly AutomationRun[],
  automationById: ReadonlyMap<string, Automation>,
  rowByPaneKey: ReadonlyMap<string, AgentStatusIpcPayload>
): BotChatFacts[] {
  return runs.flatMap((run): BotChatFacts[] => {
    const automation = automationById.get(run.automationId)
    if (run.chatSessionId || !automation) {
      return []
    }
    const running = automationRunDot(run.status) === 'working'
    const pane = run.terminalPaneKey ? chatLive(rowByPaneKey.get(run.terminalPaneKey)) : 'idle'
    return [
      {
        chatId: terminalRunChatId(run.id),
        title: automation.name,
        origin: 'automation',
        live: running ? (pane === 'needs-you' ? 'needs-you' : 'replying') : 'idle',
        lastActiveAt: getAutomationRunLastRunAt(run),
        unread: false,
        closed: false,
        tab: false,
        run: {
          automationId: automation.id,
          runId: run.id,
          ...(run.workspaceId ? { worktreeId: run.workspaceId } : {}),
          ...(run.terminalPaneKey ? { paneKey: run.terminalPaneKey } : {})
        }
      }
    ]
  })
}

export function terminalRunChatId(runId: string): string {
  return `run:${runId}`
}
