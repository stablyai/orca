import { z } from 'zod'
import { readPiEntries } from '../pi/rpc-history-catch-up'
import {
  piEntriesAnswerSchema,
  type PiEntriesAnswer,
  type PiSessionEntry
} from '../pi/rpc-history-import'
import type { PiRpcConnection } from '../pi/rpc-session'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { readJsonlLinesFromOffset } from '../usage/jsonl-line-offsets'
import { readJsonlFileSnapshot, sameJsonlFileSnapshot } from '../usage/jsonl-file-snapshot'
import { ompRpcUserMessageSchema } from './rpc-user-message'

const titleSlot = z.object({ type: z.literal('title'), v: z.literal(1), title: z.string() })
const sessionHeader = z.object({
  type: z.literal('session'),
  id: z.string().min(1),
  version: z.number().int().min(2)
})

function rewindEntry(entry: PiSessionEntry): PiSessionEntry {
  const user = ompRpcUserMessageSchema.safeParse(entry.message)
  return {
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    mode: entry.mode,
    timestamp: entry.timestamp,
    customType: entry.customType,
    attribution: entry.attribution,
    ...(user.success ? { message: user.data } : {})
  }
}

/** Keep large tool results off RPC; the native cursor still proves the loaded tree's leaf. */
export async function readOmpRewindEntries(
  connection: Pick<PiRpcConnection, 'request'>,
  sessionFile: string,
  signal?: AbortSignal
): Promise<PiEntriesAnswer> {
  try {
    return await readPiEntries(connection, null)
  } catch (error) {
    if (
      !(error instanceof JsonlRpcResponseError) ||
      error.command !== 'get_entries' ||
      error.message !== 'RPC response exceeded the transport limit'
    ) {
      throw error
    }
  }
  const before = await readJsonlFileSnapshot(sessionFile)
  const entries: PiSessionEntry[] = []
  const ids = new Set<string>()
  let header = false
  let first = true
  for await (const { line, terminated } of readJsonlLinesFromOffset(sessionFile, 0)) {
    signal?.throwIfAborted()
    if (!terminated) {
      throw new Error('OMP session has an incomplete entry')
    }
    const value: unknown = JSON.parse(line)
    if (first && titleSlot.safeParse(value).success) {
      first = false
      continue
    }
    first = false
    if (!header) {
      sessionHeader.parse(value)
      header = true
      continue
    }
    const entry = piEntriesAnswerSchema.shape.entries.element.parse(value)
    if (ids.has(entry.id)) {
      throw new Error('OMP session has duplicate entry ids')
    }
    ids.add(entry.id)
    entries.push(rewindEntry(entry))
  }
  const tail = entries.at(-1)?.id
  if (!tail) {
    throw new Error('OMP session has no rewind entries')
  }
  signal?.throwIfAborted()
  const native = await readPiEntries(connection, tail)
  if (!sameJsonlFileSnapshot(before, await readJsonlFileSnapshot(sessionFile))) {
    throw new Error('OMP session changed while reading rewind entries')
  }
  for (const entry of native.entries) {
    if (ids.has(entry.id)) {
      throw new Error('OMP native entries disagree with the saved tree')
    }
    ids.add(entry.id)
    entries.push(rewindEntry(entry))
  }
  return { entries, leafId: native.leafId }
}
