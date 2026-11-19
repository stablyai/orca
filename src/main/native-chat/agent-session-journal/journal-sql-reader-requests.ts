import { createHash } from 'node:crypto'
import type { JournalSqlReaderOperation } from './journal-sql-reader-protocol'
import type { ReaderSlot } from './journal-sql-reader-slot'
import type { JournalSqlReaderWorker } from './journal-sql-reader-spawn'
import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting/crash-reporting'

/**
 * Each journal reader's oldest unanswered read, recorded on main before the reader gets it. A
 * reader that runs out of memory mid-read never replies, so its last reply can't name the read.
 */
export type JournalReaderRunningRequest = {
  operation: string
  /** A hash of the chat id: matches a local journal without putting the id in a crash report. */
  chat: string | null
  startedAt: number
  /** Requests waiting behind this one on the same reader, kept current. */
  queued: number
  /** Null while the reader runs inside the utility process. */
  threadId: number | null
}

type RunningRequestSink = (reader: number, request: JournalReaderRunningRequest | null) => void

/** The pool's reader limit; a closing reader frees its record before its replacement claims one. */
export const JOURNAL_SQL_READERS = 4
const owners: (ReaderSlot | undefined)[] = Array.from({ length: JOURNAL_SQL_READERS })
const running: (JournalReaderRunningRequest | null)[] = Array.from(
  { length: JOURNAL_SQL_READERS },
  () => null
)
let sink: RunningRequestSink | undefined

export function claimJournalReaderRecord(owner: ReaderSlot): number | undefined {
  const index = owners.indexOf(undefined)
  if (index === -1) {
    return undefined
  }
  owners[index] = owner
  return index
}

export function releaseJournalReaderRecord(owner: ReaderSlot): void {
  const index = owners.indexOf(owner)
  if (index !== -1) {
    recordJournalReaderRequest(index, null)
    owners[index] = undefined
  }
}

export function recordJournalReaderRequest(
  reader: number,
  request: JournalReaderRunningRequest | null
): void {
  running[reader] = request
  try {
    sink?.(reader, request)
  } catch {
    // Diagnostics only.
  }
}

export function readJournalReaderRequests(
  onWorkers?: readonly unknown[]
): (JournalReaderRunningRequest & { reader: number })[] {
  return running.flatMap((request, reader) =>
    request && (!onWorkers || owners[reader]?.runsOn(onWorkers)) ? [{ ...request, reader }] : []
  )
}

/** Breadcrumb fields naming each reader's oldest unanswered read. */
export function journalReaderRequestData(
  requests: readonly (JournalReaderRunningRequest & { reader: number })[]
): CrashReportBreadcrumbData {
  const data: CrashReportBreadcrumbData = {}
  for (const request of requests) {
    data[`r${request.reader}_readOp`] = request.operation
    data[`r${request.reader}_readChat`] = request.chat
    data[`r${request.reader}_readQueued`] = request.queued
    data[`r${request.reader}_readAgeMs`] = Date.now() - request.startedAt
  }
  return data
}

/** Main's crash diagnostics: called synchronously, before the reader receives the request. */
export function onJournalReaderRequest(next: RunningRequestSink): void {
  sink = next
}

export function describeJournalReaderOperation(
  operation: JournalSqlReaderOperation
): Pick<JournalReaderRunningRequest, 'operation' | 'chat'> {
  switch (operation.kind) {
    case 'point':
      return {
        operation: `point:${operation.request.operation.kind}`,
        chat: chatHash(operation.request.sessionId)
      }
    case 'domain-history':
      return { operation: operation.kind, chat: chatHash(operation.request.sessionId) }
    case 'database':
      return {
        operation: `database:${operation.operation.kind}`,
        chat:
          'sessionId' in operation.operation && operation.operation.sessionId !== undefined
            ? chatHash(operation.operation.sessionId)
            : null
      }
    case 'fork-prepare':
      return { operation: operation.kind, chat: chatHash(operation.input.source.sessionId) }
    case 'conversion-prepare':
    case 'import-state':
    case 'legacy-compare':
      return { operation: operation.kind, chat: chatHash(operation.sessionId) }
    case 'legacy-proof':
    case 'fork-next':
    case 'fork-release':
    case 'conversion-page':
    case 'conversion-release':
      return { operation: operation.kind, chat: null }
  }
}

function chatHash(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
}

/** A thread's id, including a hosted reader moved in-process; null inside the utility process. */
export function journalReaderThreadId(worker: JournalSqlReaderWorker): number | null {
  return 'threadId' in worker && typeof worker.threadId === 'number' ? worker.threadId : null
}
