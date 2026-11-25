import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { readCodexTurnStatus } from '../../app-server/codex-structured-thread-facts'
import { readRecord } from '../../app-server/codex-item-field-readers'
import {
  loadedChildren,
  loadedThreadIds,
  MAX_SNAPSHOT_THREADS,
  readSource,
  SOFT_READ_TIMEOUT_MS,
  type ChildSource
} from './codex-kept-loaded-threads'
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
import { KeptProviderRelayUnreachableError } from '../../../provider-relay/provider-relay-kept-rebind'
import { AgentSessionStartFailure } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import {
  agentSessionFailureFact,
  providerDiagnostic
} from '../../../../shared/agent-session/failures/agent-session-failure'
import type { StructuredAgentSessionHistoryJournal } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'

const PRIMARY_RETRY_MS = 500
const KEPT_UNREACHABLE_DETAIL =
  "Orca couldn't reconnect to this chat's agent, which is still running. Send again to reconnect."

type Connection = Pick<CodexAppServerConnection, 'request'>

/** What a kept agent says of itself at reattach: each thread's turns and its children. */
export type KeptCodexSnapshot = { turns: KeptCodexTurn[]; spawns: KeptCodexSpawn[] }

type ThreadRead = { turn: KeptCodexTurn | null; source: ChildSource | null }

/**
 * One thread's latest turn whole (its messages' numbering, running commands and state). One turn
 * read per thread: a read rebuilds the thread's history in the agent, so it is never repeated.
 * Only the chat's own read is required; any other that fails is logged and left out.
 */
async function readKeptThread(input: {
  connection: Connection
  translator: Pick<CodexJournalTranslator, 'seedKeptTurns'>
  threadId: string
  primary: boolean
  /** Already read (an idle loaded child's); otherwise read beside its turn. */
  source?: ChildSource | null
  timeoutMs: number
  onError: (threadId: string, error: unknown) => void
}): Promise<ThreadRead> {
  const { connection, threadId, timeoutMs } = input
  const soft = <T>(read: Promise<T>, fallback: T): Promise<T> =>
    read.catch((error: unknown) => {
      input.onError(threadId, error)
      return fallback
    })
  const latest = (ms: number) =>
    connection
      .request(
        'thread/turns/list',
        { threadId, sortDirection: 'desc', limit: 1, itemsView: 'full' },
        { timeoutMs: ms }
      )
      .then((page) => {
        const data = readRecord(page).data
        return readRecord(Array.isArray(data) ? data[0] : null)
      })
  const [turn, source] = await Promise.all([
    input.primary
      ? latest(timeoutMs).catch(async (error: unknown) => {
          input.onError(threadId, error)
          await new Promise((resolve) => setTimeout(resolve, PRIMARY_RETRY_MS))
          // Bounded, so a wedged agent holds a launch slot only a little past one request.
          return latest(Math.min(timeoutMs, SOFT_READ_TIMEOUT_MS))
        })
      : soft(latest(timeoutMs), {}),
    input.primary || input.source !== undefined
      ? (input.source ?? null)
      : soft(readSource(connection, threadId, timeoutMs), null)
  ])
  if (typeof turn.id !== 'string') {
    return { turn: null, source }
  }
  const status = readCodexTurnStatus(turn)
  input.translator.seedKeptTurns(threadId, [{ id: turn.id, running: status === 'inProgress' }])
  const items = (Array.isArray(turn.items) ? turn.items : []).flatMap(
    (value) => readCodexThreadItem(value) ?? []
  )
  return { turn: { threadId, turnId: turn.id, status, items }, source }
}

/** A child as the tracker learns of it from a spawn, so Stop reaches it and its end settles it. */
function spawnOf(
  parentThreadId: string,
  childThreadId: string,
  label: string | null = null
): KeptCodexSpawn {
  return {
    threadId: parentThreadId,
    turnId: '',
    item: {
      type: CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE,
      id: `kept-subagent:${childThreadId}`,
      tool: 'spawnAgent',
      status: 'completed',
      // A spawn's prompt is what names its child's row.
      ...(label ? { prompt: label } : {}),
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
 * from the agent itself — the chat's thread and every other thread its app-server has loaded (its
 * agents), plus any the daemon carried or a latest turn spawned. Threads are read in parallel waves.
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
  /** The app-server runs for this chat alone (never a shared one). */
  ownServer: boolean
  timeoutMs: number
  onError: (threadId: string, error: unknown) => void
}): Promise<KeptCodexSnapshot> {
  const seen = new Set<string>()
  const turns: KeptCodexTurn[] = []
  const spawns: KeptCodexSpawn[] = []
  /** Children whose parent couldn't be read: placed under the chat only if no read turn spawned them. */
  const unparented: string[] = []
  // Only a chat's own app-server's loaded threads are all its agents; a shared one holds others'.
  // Asked beside the first reads; what it adds comes last, after every child something named.
  const loading = input.ownServer
    ? loadedThreadIds(input.connection, SOFT_READ_TIMEOUT_MS).catch((error: unknown) => {
        input.onError(input.threadId, error)
        return []
      })
    : Promise.resolve([])
  const readWave = async (wave: { threadId: string; source?: ChildSource }[]) => {
    const fresh = wave.filter(({ threadId }) => !seen.has(threadId))
    const room = MAX_SNAPSHOT_THREADS - seen.size
    if (fresh.length > room) {
      console.warn(`[codex] a reattach follows ${room} more threads; ${fresh.length - room} left`)
    }
    const reading = fresh.slice(0, Math.max(0, room))
    reading.forEach(({ threadId }) => seen.add(threadId))
    const reads = await Promise.all(
      reading.map(({ threadId, source }) =>
        readKeptThread({
          connection: input.connection,
          translator: input.translator,
          threadId,
          primary: threadId === input.threadId,
          ...(source ? { source } : {}),
          timeoutMs: input.timeoutMs,
          onError: input.onError
        })
      )
    )
    const named: string[] = []
    reads.forEach(({ turn, source }, i) => {
      const threadId = reading[i]!.threadId
      if (threadId !== input.threadId) {
        if (source?.parentThreadId) {
          spawns.push(spawnOf(source.parentThreadId, threadId, source.label))
        } else {
          unparented.push(threadId)
        }
      }
      if (!turn) {
        return
      }
      turns.push(turn)
      seedTurn(input.translator, turn)
      // A child spawned in this turn may still run though no carried work names it.
      for (const item of turn.items) {
        if (item.type === CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE) {
          named.push(...readReceiverThreadIds(item))
        }
      }
    })
    return [...new Set(named)].map((threadId) => ({ threadId }))
  }
  // The chat's thread and the children named by carried work or a read turn come first.
  let wave = [input.threadId, ...(input.carriedThreadIds ?? [])].map((threadId) => ({ threadId }))
  while (wave.length > 0) {
    wave = await readWave(wave)
  }
  const extra = (await loading).filter((threadId) => !seen.has(threadId))
  if (extra.length > 0) {
    wave = await loadedChildren({
      connection: input.connection,
      ids: extra,
      room: MAX_SNAPSHOT_THREADS - seen.size,
      onError: input.onError
    })
    while (wave.length > 0) {
      wave = await readWave(wave)
    }
  }
  // A spawn in a read turn names the real parent (restated with that turn); a guess must not win.
  const spawned = new Set(
    turns.flatMap(({ items }) =>
      items.flatMap((item) =>
        item.type === CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE ? readReceiverThreadIds(item) : []
      )
    )
  )
  for (const threadId of unparented) {
    if (!spawned.has(threadId)) {
      spawns.push(spawnOf(input.threadId, threadId))
    }
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

/**
 * A kept agent's snapshot, plus its running commands' saved output, before its replay is let go.
 * When the chat's own thread can't be read, the agent goes back to the daemon with its unread
 * output and the open fails retryably: a later send reattaches it. Unnumbered, the replay would
 * overwrite saved rows; ending the agent would lose its work.
 */
export async function openKeptCodexState(input: {
  connection: Pick<CodexAppServerConnection, 'request' | 'relay'>
  translator: CodexJournalTranslator
  chatKey: string
  threadId: string
  journal: { reads: Pick<StructuredAgentSessionHistoryJournal['reads'], 'itemBody'> } | null
  timeoutMs: number
  onError: (threadId: string, error: unknown) => void
}): Promise<KeptCodexSnapshot> {
  const { connection, translator, journal } = input
  const snapshot = await readKeptCodexSnapshot({
    ...input,
    carriedThreadIds: keptCodexThreadIds(connection.relay),
    ownServer: connection.relay?.ownServer === true
  }).catch(async (error: unknown) => {
    input.onError(input.threadId, error)
    await connection.relay?.keep?.()
    throw new AgentSessionStartFailure(
      new KeptProviderRelayUnreachableError(input.chatKey),
      'never',
      agentSessionFailureFact('startFailed', {
        detail: providerDiagnostic(KEPT_UNREACHABLE_DETAIL, 'person'),
        neverReachedAgent: true
      })
    )
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
