// What the run chat closer reads about one chat: the run that opened it, whether a person wrote in
// it, whether it owns an open item, and whether a Run it coordinates is still going.
import { BOT_ITEM_STATUSES, isOpenBotItemStatus } from '../../shared/bots/bot-items'
import { readAutomationRunMessage } from '../../shared/automations/automation-run-message'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { remoteHoldOnTask } from '../runtime/orchestration/db/remote-owned/remote-placements'

type JournalHost = Pick<StructuredAgentSessionHost, 'journalReads'>

// A chat's first message never changes, so each journal is opened once to tell a run's chat.
const runOfChat = new Map<string, string | null>()

/** The run whose message opened the chat; null for any other chat. */
export async function chatRunId(host: JournalHost, chatId: string): Promise<string | null> {
  if (runOfChat.has(chatId)) {
    return runOfChat.get(chatId) ?? null
  }
  const first = await (await host.journalReads(chatId)).promptItem('first')
  const body = first?.body
  const runId =
    body?.kind === 'message' && body.origin === 'automation-run'
      ? (readAutomationRunMessage(body.automationRun)?.runId ?? null)
      : null
  // A chat whose first message is still being written is told on the next look.
  if (first) {
    runOfChat.set(chatId, runId)
  }
  return runId
}

/** A person typed in it. Read as the newest prompt that is neither an agent's mail nor Orca's own
 *  (the run's first message is Orca's), so mail that came after the person does not hide them. Each
 *  /clear starts a session with its own journal, so every session the chat ran in is read. */
export async function personSpoke(
  host: JournalHost,
  sessions: readonly string[]
): Promise<boolean> {
  for (const sessionId of sessions) {
    if ((await (await host.journalReads(sessionId)).promptItem('last-person')) !== null) {
      return true
    }
  }
  return false
}

/** It owns an item not done or canceled, by the exact counts per status, which no page limit cuts. */
export async function ownsOpenItem(
  runtime: Pick<OrcaRuntimeService, 'botItems'>,
  botId: string,
  chatId: string
): Promise<boolean> {
  const { counts } = await runtime.botItems
    .store()
    .list({ botId, statuses: [], chatIds: [chatId], limit: 0 })
  return BOT_ITEM_STATUSES.some(
    (status) => isOpenBotItemStatus(status) && (counts[status] ?? 0) > 0
  )
}

/** A Run it coordinates has a worker still going, as a new start of the Task would find one: its
 *  Dispatch here is pending or out, or a paired server holds the Task, which keeps no Dispatch here.
 *  A Dispatch that settled revoked its worker's right to report, so its process, if still up, is
 *  idle at its prompt, and a word from it reaches whichever chat coordinates the Run then. */
export function coordinatesLiveRun(db: OrchestrationDb, sessionId: string): boolean {
  if (!isOrcaSessionId(sessionId)) {
    return false
  }
  const runs = db.runsBoundToCoordinator({
    orcaSessionId: sessionId,
    paneKey: null,
    terminalHandle: null
  })
  if (runs.length === 0) {
    return false
  }
  const live = db.db.prepare(
    `SELECT 1 FROM dispatch_contexts WHERE run_id = ? AND status IN ('pending', 'dispatched') LIMIT 1`
  )
  const placed = db.db.prepare('SELECT task_id FROM remote_placements WHERE run_id = ?')
  return runs.some(
    (run) =>
      live.get(run.id) !== undefined ||
      placed.all(run.id).some((row) => remoteHoldOnTask(db, String(row.task_id))?.liveWorker)
  )
}
