import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { codexSubagentParentThreadId } from '../../app-server/shared-servers/codex-shared-server-frames'
import { codexSubagentPathLabel } from '../../../../shared/agent-hook-listener/providers/codex/codex-agent-path'

/** The chat's own thread and the children a reattach follows; past it the rest are logged. */
export const MAX_SNAPSHOT_THREADS = 65
/** Idle children the app-server still holds, most recently active first, read beside the rest. */
const MAX_IDLE_LOADED_CHILDREN = 16
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
        { cursor, limit: MAX_SNAPSHOT_THREADS },
        { timeoutMs }
      )
    )
    ids.push(...(Array.isArray(page.data) ? page.data.filter((id) => typeof id === 'string') : []))
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null
  } while (cursor !== null && ids.length < MAX_SNAPSHOT_THREADS)
  return ids
}

/**
 * Loaded threads nothing else named: only spawned agents count, running ones first, then the most
 * recently active idle ones (a child that ended while no app was attached is among them).
 */
export async function loadedChildren(input: {
  connection: Connection
  ids: readonly string[]
  room: number
  onError: (threadId: string, error: unknown) => void
}): Promise<{ threadId: string; source: ChildSource }[]> {
  const read = await Promise.all(
    input.ids.slice(0, MAX_SNAPSHOT_THREADS).map((threadId) =>
      readSource(input.connection, threadId, SOFT_READ_TIMEOUT_MS).then(
        (source) => ({ threadId, source }),
        (error: unknown) => {
          input.onError(threadId, error)
          return null
        }
      )
    )
  )
  const children = read.flatMap((child) => (child?.source.spawned ? [child] : []))
  const active = children.filter(({ source }) => source.active)
  const idle = children
    .filter(({ source }) => !source.active)
    .sort((a, b) => b.source.updatedAt - a.source.updatedAt)
    .slice(0, MAX_IDLE_LOADED_CHILDREN)
  return [...active, ...idle].slice(0, Math.max(0, input.room))
}
