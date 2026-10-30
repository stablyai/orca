import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { runHistoryCatchUp } from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import {
  createPiHistoryImportPlan,
  piBranchInTree,
  piBranchSince,
  piEntriesAnswerSchema,
  type PiEntriesAnswer,
  type PiSessionEntry
} from './rpc-history-import'
import {
  readPiHistoryJournalView,
  samePiHistoryJournalView,
  usablePiHistoryClaim,
  type PiHistoryClaim
} from './rpc-history-journal-view'
import type { PiRpcConnection } from './rpc-session'
import { readPiSessionLastEntryId } from './rpc-session-file-tail'

export const PI_HISTORY_CATCH_UP_TIMEOUT_MS = 30_000

/** A claim at Pi's current leaf permits ongoing capture; a carried claim does not. */
export type PiHistoryCatchUp = { claim: PiHistoryClaim | null; current: boolean }

/** `get_entries`, whose oversized answer fails only this read. */
export async function readPiEntries(
  connection: Pick<PiRpcConnection, 'request'>,
  since: string | null,
  timeoutMs?: number
): Promise<PiEntriesAnswer> {
  return piEntriesAnswerSchema.parse(
    await connection.request('get_entries', since === null ? {} : { since }, {
      oversizedReply: 'reject',
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    })
  )
}

// Pi has no writer lock; terminal writes are safe only while chat Pi is stopped. Reopen reloads disk.

/** Optional reconciliation never gates the open; a failure keeps the claim the chat already had. */
export async function catchUpPiSession(input: {
  connection: Pick<PiRpcConnection, 'request'>
  sessionId: string
  sessionFile: string
  /** Include directory forks, which preserve entry IDs. */
  lineage: ReadonlySet<string>
  claim: PiHistoryClaim | null
  sink: StructuredAgentSessionEventSink | undefined
  signal: AbortSignal
  assertCurrent: () => void
  timeoutMs?: number
  logger: StructuredAgentSessionLogger
}): Promise<PiHistoryCatchUp> {
  const carried: PiHistoryCatchUp = { claim: input.claim, current: false }
  if (!input.sink) {
    return carried
  }
  let leaf: { entry: string | null } | undefined
  const outcome = await runHistoryCatchUp({
    agentName: 'Pi',
    scope: 'pi-history-catch-up',
    sessionId: input.sessionId,
    sink: input.sink,
    signal: input.signal,
    assertCurrent: input.assertCurrent,
    timeoutMs: input.timeoutMs ?? PI_HISTORY_CATCH_UP_TIMEOUT_MS,
    logger: input.logger,
    readView: (history) => readPiHistoryJournalView(history, input.lineage),
    sameView: samePiHistoryJournalView,
    prepare: async ({ view: readView, journal, signal, deadline, check, warn }) => {
      const view = readView()
      const read = async (since: string | null) => {
        check()
        const answer = await waitForPromiseWithSignal(
          readPiEntries(input.connection, since, Math.max(1, deadline - Date.now())),
          signal
        )
        check()
        return answer
      }
      const claim = usablePiHistoryClaim(input.claim, view)
      // Own work after a claim, or known history without a claim, makes the import boundary ambiguous.
      const known = view.ownWorkSequence > 0 || view.accounted.size > 0
      if (claim ? view.ownWorkSequence > claim.sequence : known) {
        leaf = { entry: await currentLeaf(input.sessionFile, read) }
        return null
      }
      let answer = claim ? await readSince(read, claim.entry) : null
      let branch: { path: PiSessionEntry[]; rewound: boolean } | null =
        answer && claim ? piBranchSince(answer, claim.entry) : null
      if (!answer || !branch) {
        answer = await read(null)
        const inTree = piBranchInTree(answer, claim?.entry ?? null)
        if (inTree === 'unknown-claim') {
          leaf = { entry: answer.leafId }
          return null
        }
        if (!inTree) {
          warn('incomplete-history')
          return null
        }
        branch = inTree
      }
      leaf = { entry: answer.leafId }
      return createPiHistoryImportPlan({
        sessionFile: input.sessionFile,
        journal,
        path: branch.path.filter((entry) => !view.accounted.has(entry.id)),
        rewound: branch.rewound,
        divider: view.hasRows,
        check
      })
    }
  })
  const history = input.sink.journalHistory?.()
  if (outcome === 'skipped' || !leaf || !history) {
    return carried
  }
  const cursor = history.cursor()
  return {
    claim:
      leaf.entry === null
        ? null
        : { entry: leaf.entry, epoch: cursor.epoch, sequence: cursor.sequence },
    current: true
  }
}

/** A missing claim entry requires a whole-tree read. */
async function readSince(
  read: (since: string | null) => Promise<PiEntriesAnswer>,
  entry: string
): Promise<PiEntriesAnswer | null> {
  try {
    return await read(entry)
  } catch (error) {
    if (error instanceof JsonlRpcResponseError && error.message.startsWith('Entry not found')) {
      return null
    }
    throw error
  }
}

/** Ask cheaply after the file tail when it matches Pi's loaded tree; otherwise read the whole tree. */
async function currentLeaf(
  sessionFile: string,
  read: (since: string | null) => Promise<PiEntriesAnswer>
): Promise<string | null> {
  const last = await readPiSessionLastEntryId(sessionFile).catch(() => null)
  const hinted = last === null ? null : await readSince(read, last)
  return (hinted ?? (await read(null))).leafId
}
