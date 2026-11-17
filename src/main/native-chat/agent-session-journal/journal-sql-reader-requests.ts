import { createHash } from 'node:crypto'
import type { JournalSqlReaderOperation } from './journal-sql-reader-protocol'

/**
 * The read each journal reader is running, recorded on main before the reader gets it. A reader
 * that runs out of memory mid-read never replies, so its last reply can't name the read; this can.
 */
export type JournalReaderRunningRequest = {
  operation: string
  /** A hash of the chat id: matches a local journal without putting the id in a crash report. */
  chat: string | null
  startedAt: number
  /** Requests waiting behind this one on the same reader, kept current. */
  queued: number
  threadId: number
}

type RunningRequestSink = (reader: number, request: JournalReaderRunningRequest | null) => void

/** The pool runs at most four readers; a closing reader frees its record first. */
const READERS = 4
const owners: (object | undefined)[] = Array.from({ length: READERS })
const running: (JournalReaderRunningRequest | null)[] = Array.from({ length: READERS }, () => null)
let sink: RunningRequestSink | undefined

export function claimJournalReaderRecord(owner: object): number | undefined {
  const index = owners.indexOf(undefined)
  if (index === -1) {
    return undefined
  }
  owners[index] = owner
  return index
}

export function releaseJournalReaderRecord(owner: object): void {
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

export function readJournalReaderRequests(): (JournalReaderRunningRequest & { reader: number })[] {
  return running.flatMap((request, reader) => (request ? [{ ...request, reader }] : []))
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
        chat: 'sessionId' in operation.operation ? chatHash(operation.operation.sessionId) : null
      }
    case 'fork-prepare':
      return { operation: operation.kind, chat: chatHash(operation.input.source.sessionId) }
    case 'conversion-prepare':
    case 'import-state':
      return { operation: operation.kind, chat: chatHash(operation.sessionId) }
    default:
      return { operation: operation.kind, chat: null }
  }
}

function chatHash(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
}
