import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { readCodexTurnStatus } from '../../app-server/codex-structured-thread-facts'
import { readRecord } from '../../app-server/codex-item-field-readers'
import type { CodexJournalTranslator } from '../journal/codex-structured-journal-contracts'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionHistoryJournal } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import {
  isCodexMessageItemType,
  readCodexThreadItem,
  type CodexThreadItem
} from '../items/codex-thread-item-identity'
import type { CodexBackgroundTaskTracker } from '../background-work/codex-background-task-tracker'
import {
  CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE,
  readReceiverThreadIds
} from '../items/codex-collab-agent-tool-call'

/** A chat with more subagents than this is past what one reattach looks up. */
const MAX_SEEDED_THREADS = 16

async function latestTurn(
  connection: Pick<CodexAppServerConnection, 'request'>,
  threadId: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const page = readRecord(
    await connection.request(
      'thread/turns/list',
      { threadId, sortDirection: 'desc', limit: 1, itemsView: 'full' },
      { timeoutMs }
    )
  )
  return Array.isArray(page.data) ? readRecord(page.data[0]) : null
}

/**
 * A reattached agent's latest turns replay or go on, but this app's message ordinals start empty,
 * so a turn's next message would take an earlier one's row. Each latest turn (the chat's and its
 * subagents') is numbered from Codex's own history first, as the live run numbered it.
 */
export async function seedKeptCodexTurnOrdinals(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  translator: Pick<CodexJournalTranslator, 'seedTurnOrdinals' | 'seedRunningItems'>
  threadId: string
  timeoutMs: number
  onError?: (threadId: string, error: unknown) => void
}): Promise<KeptCodexTurn[]> {
  const queue = [input.threadId]
  const seen = new Set<string>()
  const fetched: KeptCodexTurn[] = []
  for (
    let threadId = queue.shift();
    threadId !== undefined && seen.size < MAX_SEEDED_THREADS;
    threadId = queue.shift()
  ) {
    if (seen.has(threadId)) {
      continue
    }
    seen.add(threadId)
    // Unnumbered, the chat's replay would take its saved messages' rows, so its open fails instead.
    const turn = await latestTurn(input.connection, threadId, input.timeoutMs).catch(
      (error: unknown) => {
        if (threadId === input.threadId) {
          throw error
        }
        input.onError?.(threadId, error)
        return null
      }
    )
    if (!turn || typeof turn.id !== 'string') {
      continue
    }
    const items = (Array.isArray(turn.items) ? turn.items : []).flatMap(
      (value) => readCodexThreadItem(value) ?? []
    )
    const status = readCodexTurnStatus(turn)
    const kept: KeptCodexTurn = { threadId, turnId: turn.id, status, items }
    fetched.push(kept)
    // A command still running (a background one outlives its turn) streams on after the reattach.
    const running = items.filter(
      (item) => item.type === 'commandExecution' && item.status === 'inProgress'
    )
    const identities = input.translator.seedRunningItems(threadId, turn.id, running)
    kept.running = running.map((item, i) => ({
      itemId: item.id,
      identity: identities[i]!
    }))
    // A subagent spawned in a finished turn can still be running, so every spawn is followed.
    for (const item of items) {
      if (item.type === CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE) {
        queue.push(...readReceiverThreadIds(item))
      }
    }
    // A turn that finished while detached still replays its last messages, numbered as live.
    input.translator.seedTurnOrdinals(
      threadId,
      turn.id,
      items.filter((item) => isCodexMessageItemType(item.type)).map((item) => item.id)
    )
  }
  return fetched
}

/** Each thread's latest turn as Codex reported it at reattach. */
export type KeptCodexTurn = {
  threadId: string
  turnId: string
  status: string | null
  items: CodexThreadItem[]
  /** Its commands still running, seeded into the translator under these rows. */
  running?: { itemId: string; identity: AgentJournalItemIdentity }[]
}

/**
 * A kept command's row already shows its output up to the last ack; seeding its stream with that
 * text keeps it on view while the replay (which starts after it) and live output continue. A
 * truncated row's head can't be continued, so it waits for the command's own end.
 */
export async function seedKeptCodexCommandOutput(
  translator: Pick<CodexJournalTranslator, 'seedRunningOutput'>,
  journal: { reads: Pick<StructuredAgentSessionHistoryJournal['reads'], 'itemBody'> } | null,
  turns: readonly KeptCodexTurn[]
): Promise<void> {
  for (const { threadId, running = [] } of journal ? turns : []) {
    for (const { itemId, identity } of running) {
      const body = await journal!.reads.itemBody(agentJournalItemKey(identity)).catch(() => null)
      const output = body?.kind === 'tool-call' ? body.output : undefined
      if (output) {
        translator.seedRunningOutput(threadId, itemId, output.truncated ? null : output.head)
      }
    }
  }
}

/**
 * Background commands and subagent turns that began before the reattach: the new session's tracker
 * never saw them start, so their rows would read "status unavailable". They are restated from the
 * same history, under the same task ids, without writing any chat row. `ended` ([threadId, itemId])
 * are commands that finished while no app was attached: restated as running, so the replayed end
 * settles their rows instead of leaving them running. `open` ([threadId, itemId]) are commands the
 * daemon carried still running: restated even when history no longer reports them running.
 */
export function restateKeptCodexBackgroundWork(
  tracker: Pick<CodexBackgroundTaskTracker, 'observe' | 'publishChildWork'>,
  turns: readonly KeptCodexTurn[],
  ended: readonly (readonly string[])[] = [],
  open: readonly (readonly string[])[] = []
): void {
  if (turns.length === 0 && open.length === 0) {
    return
  }
  const restated = new Set<string>()
  const endedHere = new Set(ended.map(([threadId, itemId]) => `${threadId}\u0000${itemId}`))
  for (const { threadId, turnId, status, items } of turns) {
    const turn = { id: turnId, status: status ?? 'inProgress' }
    if (status === 'inProgress') {
      tracker.observe({ method: 'turn/started', threadId, params: { turn } })
    }
    for (const item of items) {
      const endedDetached = endedHere.has(`${threadId}\u0000${item.id}`)
      const carried = openHere(open, threadId, item.id)
      if (
        item.type === 'commandExecution' &&
        (item.status === 'inProgress' || endedDetached || carried)
      ) {
        const running = item.status === 'inProgress' ? item : { ...item, status: 'inProgress' }
        tracker.observe({ method: 'item/started', threadId, params: { turnId, item: running } })
        restated.add(`${threadId}\u0000${item.id}`)
      }
    }
    // A finished turn's live commands are its background work, as when the turn ended live.
    if (status !== 'inProgress') {
      tracker.observe({ method: 'turn/completed', threadId, params: { turn } })
    }
  }
  // Carried commands from turns history didn't return (an earlier turn's) still read running.
  for (const [threadId, itemId] of open) {
    if (threadId && itemId && !restated.has(`${threadId}\u0000${itemId}`)) {
      const item = { type: 'commandExecution', id: itemId, status: 'inProgress' }
      tracker.observe({ method: 'item/started', threadId, params: { item } })
    }
  }
  tracker.publishChildWork()
}

function openHere(open: readonly (readonly string[])[], threadId: string, itemId: string): boolean {
  return open.some(([thread, item]) => thread === threadId && item === itemId)
}
