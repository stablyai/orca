import { mapSettledWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import { readRecord } from '../codex-item-field-readers'
import { codexThreadIsActive } from '../codex-structured-thread-facts'

/** Metadata reads one shared server keeps in flight at once, across every caller. */
export const CODEX_SHARED_METADATA_READS = 4
const READ_TIMEOUT_MS = 5_000
/** Pages one listing reads at most; a server that keeps answering with more is unknown. */
const MAX_PAGES = 64

type Reads = Pick<CodexAppServerConnection, 'request'>
/** The daemon's marker groups (codex-app-server-relay.ts): `turn` [thread], `command` [thread, item]. */
export type CodexSharedOpenWork = Record<string, string[][]>

/** Every page of a cursor listing; throws when one fails or it never ends. */
async function readPages(
  reads: Reads,
  method: string,
  params: Record<string, unknown>
): Promise<unknown[]> {
  const items: unknown[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const reply = readRecord(
      await reads.request(
        method,
        { ...params, ...(cursor === null ? {} : { cursor }) },
        { timeoutMs: READ_TIMEOUT_MS }
      )
    )
    if (!Array.isArray(reply.data)) {
      throw new Error(`codex ${method} answered without a list`)
    }
    items.push(...reply.data)
    cursor = typeof reply.nextCursor === 'string' ? reply.nextCursor : null
    if (cursor === null) {
      return items
    }
  }
  throw new Error(`codex ${method} listed more pages than Orca reads`)
}

/** One loaded thread's open work: its running turn, and each background terminal's command. */
async function readThreadWork(reads: Reads, threadId: string): Promise<CodexSharedOpenWork> {
  const thread = readRecord(
    readRecord(
      await reads.request(
        'thread/read',
        { threadId, includeTurns: false },
        { timeoutMs: READ_TIMEOUT_MS }
      )
    ).thread
  )
  const status = readRecord(thread.status).type
  if (typeof status !== 'string') {
    throw new Error('codex thread/read answered without a status')
  }
  if (status === 'notLoaded') {
    // Unloaded since the listing: unloading ends its turn and its terminals.
    return { turn: [], command: [] }
  }
  const terminals = await readPages(reads, 'thread/backgroundTerminals/list', { threadId })
  const commands = terminals.flatMap((terminal) => {
    const itemId = readRecord(terminal).itemId
    return typeof itemId === 'string' ? [[threadId, itemId]] : []
  })
  return { turn: codexThreadIsActive(thread) ? [[threadId]] : [], command: commands }
}

/**
 * Every running turn and background command on the server, read from Codex itself: each loaded
 * thread's status and terminals. A waiting approval is an active turn. Null (unknown, so the daemon
 * never idle-stops it) when any read fails or answers without what it should.
 */
export async function readCodexSharedOpenWork(reads: Reads): Promise<CodexSharedOpenWork | null> {
  try {
    const loaded = (await readPages(reads, 'thread/loaded/list', {})).filter(
      (id): id is string => typeof id === 'string'
    )
    // The first failure settles it (unknown), so a hung server never waits out every read.
    let failed = false
    const read = await mapSettledWithConcurrency(loaded, CODEX_SHARED_METADATA_READS, (threadId) =>
      failed
        ? Promise.reject(new Error('codex open work is unknown already'))
        : readThreadWork(reads, threadId).catch((error: unknown) => {
            failed = true
            throw error
          })
    )
    const turn: string[][] = []
    const command: string[][] = []
    for (const result of read) {
      if (result.status !== 'fulfilled') {
        return null
      }
      turn.push(...(result.value.turn ?? []))
      command.push(...(result.value.command ?? []))
    }
    return { turn, command }
  } catch {
    return null
  }
}
