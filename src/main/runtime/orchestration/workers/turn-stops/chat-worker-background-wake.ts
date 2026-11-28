import { createHash } from 'node:crypto'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import type { WorkerTurnStopReportDeps } from './worker-turn-stop-report'
import { BACKGROUND_WAKE_SENDER } from '../../../../../shared/orchestration/mailbox/background-wake-sender'

/** Chat agents that take a turn on their own when a background task ends (Claude Code does). */
const SELF_WAKING_CHAT_AGENTS: ReadonlySet<string> = new Set(['claude'])

export function chatWakesItselfOnBackgroundExit(agentType: string | undefined): boolean {
  return agentType !== undefined && SELF_WAKING_CHAT_AGENTS.has(agentType)
}

/** Still idle on the turn end it waited from, which neither failed nor was cut: the held turn finished. */
export function heldTurnFinished(row: AgentStatusIpcPayload | null, since: number): boolean {
  const lead = row?.mainAgent
  return (
    row?.state === 'done' &&
    lead?.stateStartedAt === since &&
    (lead.outcome === undefined || lead.outcome === 'success')
  )
}

/** Its background tasks ended while the chat sat idle: wake that worker's own chat through its
 *  Dispatch mailbox, once per wait, instead of leaving it for the coordinator to relay. */
export function wakeChatWorkerAfterBackgroundExit(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  wait: { since: number; commands?: readonly string[] },
  deps: Pick<WorkerTurnStopReportDeps, 'notify'>
): void {
  const id = `msg_bgwake_${createHash('sha256')
    .update(JSON.stringify([dispatch.id, wait.since]))
    .digest('hex')
    .slice(0, 24)}`
  const to = `dispatch:${dispatch.id}`
  // Mail already waiting (an `orca-bg-wake` WAKE, say) starts that turn by itself.
  if (db.getMessageById(id) || db.getUnreadMessages(to).length > 0) {
    return
  }
  const commands = wait.commands?.length
    ? `\n\n${wait.commands.map((command) => `- ${command}`).join('\n')}`
    : ''
  const message = db.insertMessage({
    id,
    from: BACKGROUND_WAKE_SENDER,
    to,
    subject: 'Your background task finished',
    body: `Orca: the background task you left running has ended.${commands}\n\nRead its output and continue your task; if the output can't be read any more, say so rather than guess what it printed. This is not coordinator mail; don't reply to it.`,
    runId: dispatch.run_id
  })
  deps.notify(message.to_handle, message.type)
}
