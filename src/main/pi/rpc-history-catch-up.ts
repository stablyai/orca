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

/** What a catch-up leaves the chat with: the claim to save on this open's link, and whether it
 *  names Pi's current leaf (a capture may then continue from it) or was only carried forward. */
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

// Pi has no writer lock: a terminal can write the conversation only while the chat's Pi isn't
// running, and every start of the chat's Pi opens here, with Pi's view freshly loaded from disk.

/** Optional reconciliation never gates the open; a failure keeps the claim the chat already had. */
export async function catchUpPiSession(input: {
  connection: Pick<PiRpcConnection, 'request'>
  sessionId: string
  sessionFile: string
  /** Every file of this conversation: entries keep their ids across a directory fork. */
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
  // Set once Pi's current leaf is known; it stands only if nothing after it fails.
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
      // Without a claim, any Pi history the journal already shows (adopted, or an older build's
      // turns) leaves nothing to split it by; with one, neither does the chat's own work after it.
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

/** A claim Pi no longer has (a replaced file) answers as if the whole tree had to be read. */
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

/** Pi's leaf, asked cheaply after the file's last entry when the file still matches what Pi
 *  loaded, else from the whole tree. */
async function currentLeaf(
  sessionFile: string,
  read: (since: string | null) => Promise<PiEntriesAnswer>
): Promise<string | null> {
  const last = await readPiSessionLastEntryId(sessionFile).catch(() => null)
  const hinted = last === null ? null : await readSince(read, last)
  return (hinted ?? (await read(null))).leafId
}
