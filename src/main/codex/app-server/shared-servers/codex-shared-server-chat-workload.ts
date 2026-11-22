import {
  forEachWithConcurrency,
  mapSettledWithConcurrency
} from '../../../../shared/concurrency/map-with-concurrency'
import { scanCodexLeaseProcesses } from './codex-shared-lease-process-scan'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import { isCodexAppServerUnsupportedError } from '../codex-app-server-session'
import {
  listCodexThreadBackgroundTerminals,
  terminateCodexBackgroundTerminals
} from '../../structured/background-work/codex-background-terminals'
import { CODEX_SHARED_LEASE_ENV } from './codex-shared-server-lease-requests'

/** Requests one close keeps in flight on the shared pipe. */
const CLOSE_RPC_CONCURRENCY = 8

export type CodexSharedServerProcessSweep = (
  serverPid: number,
  leaseId: string,
  watcherPid?: number
) => Promise<boolean>

/** A dedicated server's close reaped the chat's whole tree; on a shared one only this lease's
 *  commands are stopped. Resolves true only on positive evidence that none is left. */
export async function stopCodexSharedChatWorkload(input: {
  rpc: Pick<CodexAppServerConnection, 'request'>
  threads: readonly string[]
  leaseId: string
  serverPid: number | undefined
  watcherPid?: number
  timeoutMs: number
  /** Stops and checks this lease's processes under the server; true only when none is left. */
  sweep?: CodexSharedServerProcessSweep
}): Promise<boolean> {
  const terminalsGone = await stopListedTerminals(input)
  if (input.serverPid === undefined) {
    return false
  }
  // Codex's own list misses a command that detached from it, and older Codex can't list at all.
  const leftovers = await (input.sweep ?? codexLeaseProcessesGone)(
    input.serverPid,
    input.leaseId,
    input.watcherPid
  )
  return terminalsGone !== false && leftovers
}

/** Lets the server drop these threads; true when Codex confirmed each (or can't unsubscribe). */
export async function unsubscribeCodexThreads(
  rpc: Pick<CodexAppServerConnection, 'request'>,
  threads: readonly string[],
  timeoutMs: number
): Promise<boolean> {
  const results = await mapSettledWithConcurrency(threads, CLOSE_RPC_CONCURRENCY, (threadId) =>
    rpc.request('thread/unsubscribe', { threadId }, { timeoutMs })
  )
  return results.every(
    (result) => result.status === 'fulfilled' || isCodexAppServerUnsupportedError(result.reason)
  )
}

/** true: listed and confirmed gone; false: one survived or Codex failed; null: Codex can't list
 *  (older versions only clean), so the process sweep alone decides. */
async function stopListedTerminals(input: {
  rpc: Pick<CodexAppServerConnection, 'request'>
  threads: readonly string[]
  timeoutMs: number
}): Promise<boolean | null> {
  try {
    // A thread whose listing failed doesn't stop the others' known terminals from being stopped.
    const settled = await mapSettledWithConcurrency(
      input.threads,
      CLOSE_RPC_CONCURRENCY,
      (threadId) => listCodexThreadBackgroundTerminals(input.rpc, threadId, input.timeoutMs)
    )
    const unchecked = settled.some((result) => result.status === 'rejected')
    const listed = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    if (listed.some((terminals) => terminals === null)) {
      await forEachWithConcurrency(input.threads, CLOSE_RPC_CONCURRENCY, async (threadId) => {
        await input.rpc
          .request('thread/backgroundTerminals/clean', { threadId }, { timeoutMs: input.timeoutMs })
          .catch((error: unknown) => {
            if (!isCodexAppServerUnsupportedError(error)) {
              throw error
            }
          })
      })
      return null
    }
    const terminals = listed.flatMap((terminals) => terminals ?? [])
    if (terminals.length === 0) {
      return !unchecked
    }
    const result = await terminateCodexBackgroundTerminals(input.rpc, terminals, {
      timeoutMs: input.timeoutMs,
      isCurrent: () => true
    })
    return !result.survived && !unchecked
  } catch {
    return false
  }
}

/** Proves none of this lease's processes is left; signals nothing, since a pid that isn't ours to
 *  reap can be reused before any signal lands. On Linux any tagged survivor, or an own process
 *  whose environment couldn't be read, leaves it unproven (the server then drains and its exit
 *  reaps the tree). macOS can't attribute a process to a chat, so there, as Codex's own clients
 *  do, the interrupted turns and the confirmed stop of the listed terminals are the proof. */
export async function codexLeaseProcessesGone(
  serverPid: number,
  leaseId: string,
  watcherPid?: number,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (platform === 'darwin') {
    return true
  }
  try {
    const scan = await scanCodexLeaseProcesses(
      CODEX_SHARED_LEASE_ENV,
      serverPid,
      platform,
      watcherPid
    )
    return (
      scan !== null &&
      scan.bounded &&
      scan.unreadable.length === 0 &&
      scan.tagged(leaseId).length === 0
    )
  } catch {
    return false
  }
}
