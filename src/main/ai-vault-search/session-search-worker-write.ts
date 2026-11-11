import type { TranscriptSessionIdentity } from '../ai-vault/transcripts/session-transcript-consumers'
import type { SessionSearchFileWrite } from './storage/session-search-index-writer'
import type { SessionSearchStore } from './storage/session-search-store'
import { readSessionSearchSnapshotRows } from './session-search-snapshot-rows'
import type {
  SearchWorkerCommand,
  SearchWorkerResponse,
  SessionSearchSnapshotRow
} from './worker/session-search-worker-protocol'
import type { SessionSearchWorkResult } from './session-search-work-queue'
import {
  invalidateSessionSearchAcceptedContent,
  settleSessionSearchContent
} from './session-search-content-settlement'

export type SessionSearchPreparedWorkerWrite = {
  write: SessionSearchFileWrite
  identity: TranscriptSessionIdentity | null
  settle(): ReturnType<typeof settleSessionSearchContent>
}

export function beginSessionSearchWorkerWrite(
  store: SessionSearchStore,
  command: Extract<SearchWorkerCommand, { op: 'begin' }>
): SessionSearchPreparedWorkerWrite | null {
  let identity: TranscriptSessionIdentity | null = null
  let reason: string | undefined
  const write = store.beginWrite(
    command.candidate,
    command.mode,
    command.offset,
    () => identity,
    false,
    undefined,
    command.metadataOnly,
    undefined,
    (revision) => {
      reason = revision
    }
  )
  return write
    ? {
        write,
        settle: () => {
          if (reason === undefined) {
            throw new Error('Session content was not accepted')
          }
          return settleSessionSearchContent(
            store,
            command.candidate,
            reason,
            !!command.metadataOnly,
            command.work
          )
        },
        get identity() {
          return identity
        },
        set identity(value) {
          identity = value
        }
      }
    : null
}

export function validSessionSearchWorkerRead(
  store: SessionSearchStore,
  command: Extract<SearchWorkerCommand, { op: 'begin' }>,
  runtimeEpoch: number
): boolean {
  const work = command.work
  return (
    !work ||
    (work.runtimeEpoch === runtimeEpoch &&
      store.catalogWork.matches({
        candidate: command.candidate,
        version: work.version,
        force: work.force,
        metadata: work.metadata,
        receipt: work
      }))
  )
}

export function finishSessionSearchWorkerWrite(
  store: SessionSearchStore,
  entry: SessionSearchPreparedWorkerWrite | undefined,
  command: Extract<SearchWorkerCommand, { op: 'finish' }>,
  path: string | undefined
): {
  accepted: boolean
  settled?: { row: SessionSearchSnapshotRow | undefined }
  settlement?: SearchWorkerResponse['settlement']
} {
  entry?.write.addPrepared!([], command.hash)
  const accepted = !!entry && entry.write.commit(command.outcome)
  if (!accepted) {
    return { accepted }
  }
  try {
    const settled = entry!.settle()
    return { accepted, settled, settlement: { disposition: 'settled', work: settled.work } }
  } catch {
    invalidateSessionSearchAcceptedContent(store, path!)
    return {
      accepted,
      settled: { row: readSessionSearchSnapshotRows(store, path)[0] },
      settlement: { disposition: 'content-accepted/settlement-rejected' }
    }
  }
}

export function sessionSearchWorkEpoch(
  result: SessionSearchWorkResult,
  runtimeEpoch: number
): SessionSearchWorkResult {
  for (const work of [...(result.works ?? []), ...(result.work ? [result.work] : [])]) {
    if (work.receipt) {
      work.receipt.runtimeEpoch = runtimeEpoch
    }
  }
  return result
}
