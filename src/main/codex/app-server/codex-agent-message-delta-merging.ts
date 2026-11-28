import { isProviderRecord } from '../../provider-process/provider-json-record'
import {
  createProviderRecordReader,
  type ProviderRecordMerging
} from '../../provider-process/provider-record-reader'

const AGENT_MESSAGE_DELTA_METHOD = 'item/agentMessage/delta'
/** A run ends here, so a resumed backlog is handed on in bounded pieces, not one record. */
export const MAX_MERGED_DELTA_CHARS = 64 * 1024
export const MAX_MERGED_DELTA_RECORDS = 256

type DeltaParams = { threadId: string; turnId: string; itemId: string; delta: string }
export type HeldCodexDeltas = {
  message: Record<string, unknown>
  params: DeltaParams
  parts: string[]
  chars: number
  /** How a continuing line starts, as Codex writes it. */
  linePrefix: string
}

function deltaParams(record: unknown): DeltaParams | null {
  if (!isProviderRecord(record) || record.method !== AGENT_MESSAGE_DELTA_METHOD || 'id' in record) {
    return null
  }
  const params = record.params
  if (!isProviderRecord(params)) {
    return null
  }
  const { threadId, turnId, itemId, delta, ...rest } = params
  // Unknown fields can't be merged safely, so such a delta passes through alone.
  return typeof threadId === 'string' &&
    typeof turnId === 'string' &&
    typeof itemId === 'string' &&
    typeof delta === 'string' &&
    Object.keys(rest).length === 0
    ? { threadId, turnId, itemId, delta }
    : null
}

/**
 * Same-task batching: Codex writes most message deltas in bursts that arrive in one read, so a
 * run of deltas for one item reaches the handlers as one, with its text joined in order.
 */
export const CODEX_AGENT_MESSAGE_DELTA_MERGING: ProviderRecordMerging<HeldCodexDeltas> = {
  start: (record) => {
    const params = deltaParams(record)
    if (!params || !isProviderRecord(record)) {
      return null
    }
    const ids = [
      `"threadId":${JSON.stringify(params.threadId)}`,
      `"turnId":${JSON.stringify(params.turnId)}`,
      `"itemId":${JSON.stringify(params.itemId)}`
    ].join(',')
    const linePrefix = `{"method":"${AGENT_MESSAGE_DELTA_METHOD}","params":{${ids},"delta":`
    const parts = [params.delta]
    return { message: record, params, parts, chars: params.delta.length, linePrefix }
  },
  continues: (held, text, start) =>
    held.chars < MAX_MERGED_DELTA_CHARS &&
    held.parts.length < MAX_MERGED_DELTA_RECORDS &&
    text.startsWith(held.linePrefix, start),
  add: (held, record) => {
    const params = deltaParams(record)
    if (
      !params ||
      !isProviderRecord(record) ||
      params.itemId !== held.params.itemId ||
      params.turnId !== held.params.turnId ||
      params.threadId !== held.params.threadId
    ) {
      return false
    }
    held.parts.push(params.delta)
    held.chars += params.delta.length
    held.message = record
    return true
  },
  finish: ({ message, params, parts }) =>
    parts.length === 1 ? message : { ...message, params: { ...params, delta: parts.join('') } }
}

/** An app-server stdout reader that hands each run of message deltas on as one record. */
export function createCodexRecordReader(
  input: Omit<Parameters<typeof createProviderRecordReader>[0], 'merging'>
): ReturnType<typeof createProviderRecordReader> {
  return createProviderRecordReader({ ...input, merging: CODEX_AGENT_MESSAGE_DELTA_MERGING })
}
