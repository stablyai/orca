import { mapSettledWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import { readRecord } from '../codex-item-field-readers'
import { readCodexTurnStatus } from '../codex-structured-thread-facts'
import {
  stopCodexSharedChatWorkload,
  unsubscribeCodexThreads,
  type CodexSharedServerProcessSweep
} from './codex-shared-server-chat-workload'
import { CODEX_SHARED_REATTACH_READS } from './codex-shared-server-reattach'

const END_TIMEOUT_MS = 5_000

/** `interrupted`: each thread's turn was read and, if running, interrupted. `workloadGone`: its
 *  commands are proven gone (as far as the platform can tell). */
export type CodexSharedThreadsEnded = { interrupted: boolean; workloadGone: boolean }

/**
 * Ends what threads no chat will take back still run on a kept server (true once every one's turn
 * was read and, if running, interrupted): each one's latest turn is
 * interrupted (it may have started before this app attached, so it is read, not remembered), its
 * commands are stopped (by its chat's tag when one is known), and Codex lets the threads go.
 */
export async function endCodexSharedThreads(input: {
  connection: CodexAppServerConnection
  /** The server's shared, limited requests: every one this cleanup sends goes through them. */
  reads: Pick<CodexAppServerConnection, 'request'>
  threads: readonly string[]
  /** The chat's tag; null for threads no chat's record names (only Codex's own list is stopped). */
  workload: string | null
  serverPid: number | undefined
  sweep?: CodexSharedServerProcessSweep
}): Promise<CodexSharedThreadsEnded> {
  const { connection, threads } = input
  if (threads.length === 0 || connection.closed) {
    return { interrupted: threads.length === 0, workloadGone: threads.length === 0 }
  }
  const interrupts = await mapSettledWithConcurrency(
    threads,
    CODEX_SHARED_REATTACH_READS,
    async (threadId) => {
      const page = readRecord(
        await input.reads.request(
          'thread/turns/list',
          { threadId, sortDirection: 'desc', limit: 1 },
          { timeoutMs: END_TIMEOUT_MS }
        )
      )
      const turn = readRecord(Array.isArray(page.data) ? page.data[0] : null)
      if (typeof turn.id === 'string' && readCodexTurnStatus(turn) === 'inProgress') {
        await input.reads.request(
          'turn/interrupt',
          { threadId, turnId: turn.id },
          { timeoutMs: END_TIMEOUT_MS }
        )
      }
    }
  )
  const sweep = input.workload === null ? async () => true : input.sweep
  const workloadGone = await stopCodexSharedChatWorkload({
    rpc: input.reads,
    threads,
    leaseId: input.workload ?? '',
    serverPid: input.serverPid,
    ...(sweep ? { sweep } : {}),
    ...(connection.watcherPid !== undefined ? { watcherPid: connection.watcherPid } : {}),
    timeoutMs: END_TIMEOUT_MS
  }).catch(() => false)
  // Stopped as a close counts it: each turn was read and, if running, interrupted.
  const interrupted = interrupts.every((read) => read.status === 'fulfilled')
  if (interrupted) {
    // A thread that may still run stays subscribed: what it says next is held, not missed.
    await unsubscribeCodexThreads(input.reads, threads, END_TIMEOUT_MS).catch(() => false)
  }
  return { interrupted, workloadGone }
}
