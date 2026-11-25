import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { CodexAppServerTimeoutError } from '../../app-server/codex-app-server-request-error'
import { codexSubagentParentThreadId } from '../../app-server/shared-servers/codex-shared-server-frames'
import { codexSubagentPathLabel } from '../../../../shared/agent-hook-listener/providers/codex/codex-agent-path'

/** The chat's own thread and the children a reattach follows; past it the rest are logged. */
export const MAX_SNAPSHOT_THREADS = 65
/** Idle children the app-server still holds, most recently active first, read beside the rest. */
const MAX_IDLE_LOADED_CHILDREN = 16
/** Loaded threads looked at, in pages; every one is checked so a running child is never missed. */
const MAX_LOADED_THREADS = 512
/** Metadata reads in flight at once, so a large list never floods the agent. */
const LOADED_READ_CONCURRENCY = 8
/** The whole loaded phase's budget: past it no read starts, and what is in flight is let go. */
const LOADED_PHASE_BUDGET_MS = 5_000
/** After the named children, threads the budget skipped get this long for one more read. */
export const SKIPPED_READ_GRACE_MS = 2_000
/** A short bound for reads that only add to the snapshot (and for the chat thread's retry). */
export const SOFT_READ_TIMEOUT_MS = 5_000

type Connection = Pick<CodexAppServerConnection, 'request'>

/** `spawned`: the thread is a spawned agent (others, a review's for one, are never children). */
export type ChildSource = {
  parentThreadId: string | null
  label: string | null
  spawned: boolean
  active: boolean
  updatedAt: number
}

/** A child's parent and the name it was spawned under, as the live spawn labelled it. */
function readChildSource(result: unknown): ChildSource {
  const thread = readRecord(readRecord(result).thread)
  const subAgent = readRecord(readRecord(thread.source).subAgent)
  const spawn = readRecord(subAgent.thread_spawn)
  const path = typeof spawn.agent_path === 'string' ? spawn.agent_path : null
  const nickname = typeof thread.agentNickname === 'string' ? thread.agentNickname : null
  return {
    parentThreadId: codexSubagentParentThreadId(result),
    label: codexSubagentPathLabel(path) ?? nickname,
    spawned: Object.hasOwn(subAgent, 'thread_spawn'),
    active: readRecord(thread.status).type === 'active',
    updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : 0
  }
}

export function readSource(connection: Connection, threadId: string, timeoutMs: number) {
  return connection
    .request('thread/read', { threadId, includeTurns: false }, { timeoutMs })
    .then(readChildSource)
}

/** Threads the app-server holds in memory, a page at a time. */
export async function loadedThreadIds(
  connection: Connection,
  timeoutMs: number
): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null = null
  do {
    const page = readRecord(
      await connection.request(
        'thread/loaded/list',
        { cursor, limit: MAX_LOADED_THREADS - ids.length },
        { timeoutMs }
      )
    )
    ids.push(...(Array.isArray(page.data) ? page.data.filter((id) => typeof id === 'string') : []))
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null
  } while (cursor !== null && ids.length < MAX_LOADED_THREADS)
  return ids
}

/**
 * Runs `read` over `items` in order, at most `limit` in flight, starting none past `deadline`.
 * Each result sits at its item's index; one never started is undefined.
 */
export async function readBounded<T, R>(
  items: readonly T[],
  limit: number,
  deadline: number,
  read: (item: T, remainingMs: number) => Promise<R>
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = Array.from({ length: items.length }, () => undefined)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let at = next++; at < items.length; at = next++) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        return
      }
      results[at] = await read(items[at]!, remainingMs)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Loaded threads nothing else named, under one budget: newest first (ids are time-ordered), as a
 * running child is likeliest among them. Only spawned agents count, running ones first, then the
 * most recently active idle ones (a child that ended while no app was attached is among them). One
 * whose metadata read failed (not merely ran out of budget) is still followed by its turns; those
 * that ran out of time or were never reached are `skipped`, newest first, for a turns-only read.
 */
export async function loadedChildren(input: {
  connection: Connection
  ids: readonly string[]
  room: number
  onError: (threadId: string, error: unknown) => void
}): Promise<{
  children: { threadId: string; source: ChildSource | null }[]
  skipped: string[]
}> {
  if (input.room <= 0 || input.ids.length === 0) {
    return { children: [], skipped: [] }
  }
  const deadline = Date.now() + LOADED_PHASE_BUDGET_MS
  const newestFirst = [...input.ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const read = await readBounded(
    newestFirst,
    LOADED_READ_CONCURRENCY,
    deadline,
    (threadId, remainingMs) =>
      readSource(input.connection, threadId, Math.min(SOFT_READ_TIMEOUT_MS, remainingMs)).then(
        (source) => ({ threadId, source }),
        (error: unknown) => {
          input.onError(threadId, error)
          // Out of time (the budget's or the agent's) is no reason to wait on its turns too.
          return error instanceof CodexAppServerTimeoutError ? null : { threadId, source: null }
        }
      )
  )
  const answered = read.flatMap((child) => (child ? [child] : []))
  const skipped = newestFirst.filter((_, at) => !read[at])
  const known = answered.flatMap((child) =>
    child.source?.spawned ? [{ ...child, source: child.source }] : []
  )
  const unknown = answered.filter((child) => child.source === null)
  const active = known.filter(({ source }) => source.active)
  const idle = known
    .filter(({ source }) => !source.active)
    .sort((a, b) => b.source.updatedAt - a.source.updatedAt)
    .slice(0, MAX_IDLE_LOADED_CHILDREN)
  const children = [...active, ...unknown, ...idle].slice(0, Math.max(0, input.room))
  return { children, skipped }
}
