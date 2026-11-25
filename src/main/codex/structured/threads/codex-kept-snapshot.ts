import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { readCodexTurnStatus } from '../../app-server/codex-structured-thread-facts'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { codexSubagentParentThreadId } from '../../app-server/shared-servers/codex-shared-server-frames'
import type { CodexJournalTranslator } from '../journal/codex-structured-journal-contracts'
import { isCodexMessageItemType, readCodexThreadItem } from '../items/codex-thread-item-identity'
import {
  CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE,
  readReceiverThreadIds
} from '../items/codex-collab-agent-tool-call'
import {
  keptCodexThreadIds,
  seedCarriedKeptCodexCommands,
  seedKeptCodexCommandOutput,
  type KeptCodexSpawn,
  type KeptCodexTurn
} from './codex-kept-turn-ordinals'
import type { StructuredAgentSessionHistoryJournal } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'

/** The chat's own thread and the children a reattach follows; past it the rest are logged. */
const MAX_SNAPSHOT_THREADS = 65
/** Recent turns read for their state: a replay rarely spans more of one thread's turns. */
const SNAPSHOT_TURNS = 16

type Connection = Pick<CodexAppServerConnection, 'request'>

/** What a kept agent says of itself at reattach: each thread's turns and its children. */
export type KeptCodexSnapshot = { turns: KeptCodexTurn[]; spawns: KeptCodexSpawn[] }

type ThreadRead = { turn: KeptCodexTurn | null; parentThreadId: string | null }

async function turnPage(
  connection: Connection,
  threadId: string,
  limit: number,
  itemsView: 'full' | 'summary',
  timeoutMs: number
): Promise<Record<string, unknown>[]> {
  const page = readRecord(
    await connection.request(
      'thread/turns/list',
      { threadId, sortDirection: 'desc', limit, itemsView },
      { timeoutMs }
    )
  )
  return Array.isArray(page.data) ? page.data.map((turn) => readRecord(turn)) : []
}

/**
 * One thread's state: its latest turn whole (its messages' numbering and running commands), its
 * recent turns' states for the translator, and for a child its parent. Only the chat's own latest
 * turn is required; any other read that fails is logged and left out.
 */
async function readKeptThread(input: {
  connection: Connection
  translator: Pick<CodexJournalTranslator, 'seedKeptTurns'>
  threadId: string
  primary: boolean
  timeoutMs: number
  onError: (threadId: string, error: unknown) => void
}): Promise<ThreadRead> {
  const { connection, threadId, timeoutMs } = input
  const soft = <T>(read: Promise<T>, fallback: T): Promise<T> =>
    read.catch((error: unknown) => {
      input.onError(threadId, error)
      return fallback
    })
  const latest = turnPage(connection, threadId, 1, 'full', timeoutMs)
  const [[turn], recent, parentThreadId] = await Promise.all([
    input.primary ? latest : soft(latest, []),
    soft(turnPage(connection, threadId, SNAPSHOT_TURNS, 'summary', timeoutMs), []),
    input.primary
      ? null
      : soft(
          connection
            .request('thread/read', { threadId, includeTurns: false }, { timeoutMs })
            .then(codexSubagentParentThreadId),
          null
        )
  ])
  const states = [...(turn ? [turn] : []), ...recent].flatMap((record) =>
    typeof record.id === 'string'
      ? [{ id: record.id, running: readCodexTurnStatus(record) === 'inProgress' }]
      : []
  )
  input.translator.seedKeptTurns(threadId, states)
  if (!turn || typeof turn.id !== 'string') {
    return { turn: null, parentThreadId }
  }
  const items = (Array.isArray(turn.items) ? turn.items : []).flatMap(
    (value) => readCodexThreadItem(value) ?? []
  )
  return {
    turn: { threadId, turnId: turn.id, status: readCodexTurnStatus(turn), items },
    parentThreadId
  }
}

/** A child as the tracker learns of it from a spawn, so Stop reaches it and its end settles it. */
function spawnOf(parentThreadId: string, childThreadId: string): KeptCodexSpawn {
  return {
    threadId: parentThreadId,
    turnId: '',
    item: {
      type: CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE,
      id: `kept-subagent:${childThreadId}`,
      tool: 'spawnAgent',
      status: 'completed',
      receiverThreadIds: [childThreadId]
    }
  }
}

/** Parents before their children, so each registers under one already known. */
function parentsFirst(spawns: KeptCodexSpawn[], primaryThreadId: string): KeptCodexSpawn[] {
  const known = new Set([primaryThreadId])
  const ordered: KeptCodexSpawn[] = []
  let rest = spawns
  while (rest.length > 0) {
    const ready = rest.filter((spawn) => known.has(spawn.threadId))
    const next = ready.length > 0 ? ready : rest
    for (const spawn of next) {
      ordered.push(spawn)
      readReceiverThreadIds(spawn.item).forEach((id) => known.add(id))
    }
    rest = rest.filter((spawn) => !next.includes(spawn))
  }
  return ordered
}

/**
 * The terminal daemon's model for a kept agent: before its replay, the app learns the live state
 * from the agent itself — the chat's thread and every thread the daemon carried a turn of (known
 * after a crash too), plus children their latest turns spawned. Threads are read in parallel waves.
 * The translator is seeded with each thread's turns (a replayed start of a finished one writes
 * nothing) and numbering; the caller registers the children and restates the running work.
 */
export async function readKeptCodexSnapshot(input: {
  connection: Connection
  translator: Pick<
    CodexJournalTranslator,
    'seedTurnOrdinals' | 'seedRunningItems' | 'seedKeptTurns'
  >
  threadId: string
  carriedThreadIds?: readonly string[]
  timeoutMs: number
  onError: (threadId: string, error: unknown) => void
}): Promise<KeptCodexSnapshot> {
  const seen = new Set<string>()
  const turns: KeptCodexTurn[] = []
  const spawns: KeptCodexSpawn[] = []
  let wave = [input.threadId, ...(input.carriedThreadIds ?? [])]
  while (wave.length > 0) {
    const threads = [...new Set(wave)].filter((id) => !seen.has(id))
    const room = MAX_SNAPSHOT_THREADS - seen.size
    if (threads.length > room) {
      console.warn(`[codex] a reattach follows ${room} more threads; ${threads.length - room} left`)
    }
    const reading = threads.slice(0, Math.max(0, room))
    reading.forEach((id) => seen.add(id))
    const reads = await Promise.all(
      reading.map((threadId) =>
        readKeptThread({
          connection: input.connection,
          translator: input.translator,
          threadId,
          primary: threadId === input.threadId,
          timeoutMs: input.timeoutMs,
          onError: input.onError
        })
      )
    )
    wave = []
    reads.forEach(({ turn, parentThreadId }, i) => {
      const threadId = reading[i]!
      if (threadId !== input.threadId) {
        spawns.push(spawnOf(parentThreadId ?? input.threadId, threadId))
      }
      if (!turn) {
        return
      }
      turns.push(turn)
      seedTurn(input.translator, turn)
      // A child spawned in this turn may still run though no carried work names it.
      for (const item of turn.items) {
        if (item.type === CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE) {
          wave.push(...readReceiverThreadIds(item))
        }
      }
    })
  }
  return { turns, spawns: parentsFirst(spawns, input.threadId) }
}

/** A latest turn's messages keep the live run's numbering; its running commands keep their rows. */
function seedTurn(
  translator: Pick<CodexJournalTranslator, 'seedTurnOrdinals' | 'seedRunningItems'>,
  turn: KeptCodexTurn
): void {
  const { threadId, turnId, items } = turn
  // A command still running (a background one outlives its turn) streams on after the reattach.
  const running = items.filter(
    (item) => item.type === 'commandExecution' && item.status === 'inProgress'
  )
  const identities = translator.seedRunningItems(threadId, turnId, running)
  turn.running = running.map((item, i) => ({ itemId: item.id, identity: identities[i]! }))
  // A turn that finished while detached still replays its last messages, numbered as live.
  translator.seedTurnOrdinals(
    threadId,
    turnId,
    items.filter((item) => isCodexMessageItemType(item.type)).map((item) => item.id)
  )
}

/** A kept agent's snapshot, plus its running commands' saved output, before its replay is let go. */
export async function openKeptCodexState(input: {
  connection: Pick<CodexAppServerConnection, 'request' | 'relay'>
  translator: CodexJournalTranslator
  threadId: string
  journal: { reads: Pick<StructuredAgentSessionHistoryJournal['reads'], 'itemBody'> } | null
  timeoutMs: number
  onError: (threadId: string, error: unknown) => void
}): Promise<KeptCodexSnapshot> {
  const { connection, translator, journal } = input
  const snapshot = await readKeptCodexSnapshot({
    ...input,
    carriedThreadIds: keptCodexThreadIds(connection.relay)
  })
  await seedKeptCodexCommandOutput(translator, journal, snapshot.turns)
  await seedCarriedKeptCodexCommands(
    translator,
    journal,
    snapshot.turns,
    connection.relay?.openWork()?.command
  )
  return snapshot
}
