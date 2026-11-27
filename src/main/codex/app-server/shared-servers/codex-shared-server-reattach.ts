import { mapSettledWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import { readSource, SOFT_READ_TIMEOUT_MS } from '../../structured/threads/codex-kept-loaded-threads'
import { readRecord } from '../codex-item-field-readers'
import {
  CODEX_SHARED_RECOVERY_MAX_IDENTITIES,
  type CodexRecoveredChat,
  type CodexSharedServerRecovery
} from './codex-shared-server-recovery'

/** Metadata reads one reattach keeps in flight on the shared server. */
export const CODEX_SHARED_REATTACH_READS = 4
/** Ancestors followed past the loaded threads themselves (an unloaded helper between two). */
const MAX_ANCESTOR_ROUNDS = 8

type Connection = Pick<CodexAppServerConnection, 'request'>

const LISTING_ATTEMPTS = 3

/** Every loaded thread, page by page up to what the server may hold, each page retried. A listing
 *  that still fails is partial: it only leaves threads undiscovered, it never settles a chat. */
async function listLoaded(connection: Connection): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null = null
  for (let failures = 0; failures < LISTING_ATTEMPTS; ) {
    try {
      const page = readRecord(
        await connection.request(
          'thread/loaded/list',
          { cursor, limit: CODEX_SHARED_RECOVERY_MAX_IDENTITIES - ids.length },
          { timeoutMs: SOFT_READ_TIMEOUT_MS }
        )
      )
      ids.push(...(Array.isArray(page.data) ? page.data.filter((id) => typeof id === 'string') : []))
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null
      if (cursor === null || ids.length >= CODEX_SHARED_RECOVERY_MAX_IDENTITIES) {
        break
      }
    } catch {
      failures += 1
    }
  }
  return ids
}

/** A thread's parent as Codex reads it; undefined when the read failed. */
type Parents = Map<string, string | null | undefined>

async function readParents(connection: Connection, ids: readonly string[], into: Parents) {
  const reads = await mapSettledWithConcurrency(ids, CODEX_SHARED_REATTACH_READS, (threadId) =>
    readSource(connection, threadId, SOFT_READ_TIMEOUT_MS)
  )
  reads.forEach((read, at) => {
    into.set(ids[at]!, read.status === 'fulfilled' ? read.value.parentThreadId : undefined)
  })
}

/** Where a thread's ancestry ends: at a held thread, at a top-level thread, or at a failed read. */
function ancestry(threadId: string, parents: Parents, held: (id: string) => boolean) {
  const chain: string[] = []
  const seen = new Set<string>()
  let at: string | null | undefined = threadId
  while (typeof at === 'string' && !held(at) && !seen.has(at)) {
    seen.add(at)
    chain.push(at)
    at = parents.has(at) ? parents.get(at) : undefined
  }
  const end =
    typeof at === 'string' && held(at) ? ('held' as const) : at === null ? 'top' : 'unread'
  return { chain: chain.toReversed(), end, anchor: typeof at === 'string' ? at : null }
}

/**
 * A reattached server's recovery-owned state, before its output is let through: each expected
 * chat's thread, then every loaded thread placed under the chat its ancestry reaches. One whose
 * ancestry can't be read is held as an unresolved root; one whose root is a top-level thread no
 * expected chat holds is unwanted. Returns the unwanted threads, for the server to let go.
 */
export async function recoverCodexSharedServerThreads(input: {
  connection: Connection
  recovery: CodexSharedServerRecovery
  expected: readonly CodexRecoveredChat[]
}): Promise<string[]> {
  const { connection, recovery } = input
  for (const chat of input.expected) {
    recovery.expect(chat)
  }
  const loaded = await listLoaded(connection)
  const parents: Parents = new Map()
  let unread = loaded.filter((threadId) => !recovery.holds(threadId))
  for (let round = 0; unread.length > 0 && round <= MAX_ANCESTOR_ROUNDS; round += 1) {
    await readParents(connection, unread, parents)
    // A parent that isn't loaded is read too: an expected chat's helper may sit between them.
    unread = [
      ...new Set(
        [...parents.values()].filter(
          (parent): parent is string =>
            typeof parent === 'string' && !recovery.holds(parent) && !parents.has(parent)
        )
      )
    ]
  }
  const unwanted: string[] = []
  for (const threadId of loaded) {
    if (recovery.holds(threadId)) {
      continue
    }
    const { chain, end, anchor } = ancestry(threadId, parents, (id) => recovery.holds(id))
    if (end === 'top') {
      unwanted.push(threadId)
      continue
    }
    if (end === 'unread') {
      // The furthest thread whose parent couldn't be read stands in for the unknown owner.
      recovery.holdUnowned(chain[0]!)
    }
    for (let at = end === 'held' ? 0 : 1; at < chain.length; at += 1) {
      recovery.join(chain[at]!, at === 0 ? anchor! : chain[at - 1]!)
    }
  }
  return unwanted
}
