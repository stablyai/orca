import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import type { CodexJournalTranslator } from '../journal/codex-structured-journal-contracts'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionHistoryJournal } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import { jsonObject } from '../../../../shared/json-stream/json-value-property'
import { codexNonMessageIdentity, type CodexThreadItem } from '../items/codex-thread-item-identity'
import { codexChildMessageText } from '../background-work/codex-child-work-translation'
import type { CodexBackgroundTaskTracker } from '../background-work/codex-background-task-tracker'
import { CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE } from '../items/codex-collab-agent-tool-call'

/** A subagent spawn as the tracker observes it. */
export type KeptCodexSpawn = { threadId: string; turnId: string; item: CodexThreadItem }

/** Threads beside the chat's own whose turns the daemon carried (open or ended), after a crash too. */
export function keptCodexThreadIds(
  relay: Pick<NonNullable<CodexAppServerConnection['relay']>, 'openWork' | 'endedWork'> | undefined
): string[] {
  return [...(relay?.openWork()?.turn ?? []), ...(relay?.endedWork()?.turn ?? [])].flatMap(
    ([threadId]) => threadId ?? []
  )
}

/** Each thread's latest turn as Codex reported it at reattach. */
export type KeptCodexTurn = {
  threadId: string
  turnId: string
  status: string | null
  items: CodexThreadItem[]
  /** Codex's own times (seconds), when it reports them. */
  startedAt?: number | null
  completedAt?: number | null
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
 * Commands the daemon carried open that Codex's history doesn't list as running (it can leave an
 * in-progress item out): their saved rows give back the command and output the replay continues.
 */
export async function seedCarriedKeptCodexCommands(
  translator: Pick<CodexJournalTranslator, 'seedRunningItems' | 'seedRunningOutput'>,
  journal: { reads: Pick<StructuredAgentSessionHistoryJournal['reads'], 'itemBody'> } | null,
  turns: readonly KeptCodexTurn[],
  open: readonly (readonly string[])[] = []
): Promise<void> {
  const seeded = new Set(
    turns.flatMap(({ threadId, running = [] }) =>
      running.map(({ itemId }) => `${threadId}\u0000${itemId}`)
    )
  )
  for (const [threadId, itemId] of journal ? open : []) {
    const turnId = turns.find((turn) => turn.threadId === threadId)?.turnId
    if (!threadId || !itemId || !turnId || seeded.has(`${threadId}\u0000${itemId}`)) {
      continue
    }
    const key = agentJournalItemKey(codexNonMessageIdentity(threadId, turnId, itemId))
    const body = await journal!.reads.itemBody(key).catch(() => null)
    if (body?.kind !== 'tool-call') {
      continue
    }
    const input = jsonObject(body.input) ?? {}
    const item = {
      type: 'commandExecution',
      id: itemId,
      status: 'inProgress',
      command: input.command ?? null,
      cwd: input.cwd ?? null
    }
    translator.seedRunningItems(threadId, turnId, [item])
    if (body.output) {
      translator.seedRunningOutput(
        threadId,
        itemId,
        body.output.truncated ? null : body.output.head
      )
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
  tracker: Pick<CodexBackgroundTaskTracker, 'observe' | 'publishChildWork' | 'primaryThreadId'>,
  turns: readonly KeptCodexTurn[],
  ended: readonly (readonly string[])[] = [],
  open: readonly (readonly string[])[] = [],
  spawns: readonly KeptCodexSpawn[] = []
): void {
  if (turns.length === 0 && open.length === 0 && spawns.length === 0) {
    return
  }
  // Spawns announced before the reattach register their subagents, so Stop still reaches them.
  const announce = ({ threadId, turnId, item }: KeptCodexSpawn) =>
    tracker.observe({
      method: item.status === 'inProgress' ? 'item/started' : 'item/completed',
      threadId,
      params: { turnId, item }
    })
  spawns.forEach(announce)
  const restated = new Set<string>()
  const primaryStartedAt = turns.find(
    (turn) => turn.threadId === tracker.primaryThreadId
  )?.startedAt
  const endedHere = new Set(ended.map(([threadId, itemId]) => `${threadId}\u0000${itemId}`))
  const carriedHere = new Set(open.map(([threadId, itemId]) => `${threadId}\u0000${itemId}`))
  for (const { threadId, turnId, status, items, completedAt } of turns) {
    const turn = { id: turnId, status: status ?? 'inProgress' }
    // A child that finished during the chat's latest turn (while no app was attached, say) is seen
    // working first, so its end settles its row and card as a live end does. One that finished
    // earlier was retired with the turn it ran in and is left so.
    const endedChild =
      status !== 'inProgress' &&
      threadId !== tracker.primaryThreadId &&
      endedLately(primaryStartedAt, completedAt)
    if (status === 'inProgress' || endedChild) {
      const started = { id: turnId, status: 'inProgress' }
      tracker.observe({ method: 'turn/started', threadId, params: { turn: started } })
    }
    // Its final message too (only that: each one is a store write), so its end carries it.
    const final = endedChild ? items.findLast((item) => codexChildMessageText(item)) : undefined
    if (final) {
      tracker.observe({ method: 'item/completed', threadId, params: { turnId, item: final } })
    }
    for (const item of items) {
      if (item.type === CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE) {
        announce({ threadId, turnId, item })
      }
      const endedDetached = endedHere.has(`${threadId}\u0000${item.id}`)
      const carried = carriedHere.has(`${threadId}\u0000${item.id}`)
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

/** Ended at or after the chat's latest turn started; unknown times count as late. */
function endedLately(
  since: number | null | undefined,
  completedAt: number | null | undefined
): boolean {
  return typeof completedAt !== 'number' || typeof since !== 'number' || completedAt >= since
}
