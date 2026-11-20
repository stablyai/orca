import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { scanCodexLeaseProcesses } from './codex-shared-lease-process-scan'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import { isCodexAppServerUnsupportedError } from '../codex-app-server-session'
import {
  listCodexThreadBackgroundTerminals,
  terminateCodexBackgroundTerminals
} from '../../structured/background-work/codex-background-terminals'
import { CODEX_SHARED_LEASE_ENV } from './codex-shared-server-lease-requests'

const SWEEP_SETTLE_MS = 1_000

export type CodexSharedServerProcessSweep = (serverPid: number, leaseId: string) => Promise<boolean>

/** A dedicated server's close reaped the chat's whole tree; on a shared one only this lease's
 *  commands are stopped. Resolves true only on positive evidence that none is left. */
export async function stopCodexSharedChatWorkload(input: {
  rpc: Pick<CodexAppServerConnection, 'request'>
  threads: readonly string[]
  leaseId: string
  serverPid: number | undefined
  timeoutMs: number
  /** Stops and checks this lease's processes under the server; true only when none is left. */
  sweep?: CodexSharedServerProcessSweep
}): Promise<boolean> {
  const terminalsGone = await stopListedTerminals(input)
  if (input.serverPid === undefined) {
    return false
  }
  // Codex's own list misses a command that detached from it, and older Codex can't list at all.
  const leftovers = await (input.sweep ?? stopTaggedProcesses)(input.serverPid, input.leaseId)
  return terminalsGone !== false && leftovers
}

/** true: listed and confirmed gone; false: one survived or Codex failed; null: Codex can't list
 *  (older versions only clean), so the process sweep alone decides. */
async function stopListedTerminals(input: {
  rpc: Pick<CodexAppServerConnection, 'request'>
  threads: readonly string[]
  timeoutMs: number
}): Promise<boolean | null> {
  try {
    const listed = await Promise.all(
      input.threads.map((threadId) =>
        listCodexThreadBackgroundTerminals(input.rpc, threadId, input.timeoutMs)
      )
    )
    if (listed.some((terminals) => terminals === null)) {
      await Promise.all(
        input.threads.map((threadId) =>
          input.rpc
            .request(
              'thread/backgroundTerminals/clean',
              { threadId },
              { timeoutMs: input.timeoutMs }
            )
            .catch((error: unknown) => {
              if (!isCodexAppServerUnsupportedError(error)) {
                throw error
              }
            })
        )
      )
      return null
    }
    const terminals = listed.flatMap((terminals) => terminals ?? [])
    if (terminals.length === 0) {
      return true
    }
    const result = await terminateCodexBackgroundTerminals(input.rpc, terminals, {
      timeoutMs: input.timeoutMs,
      isCurrent: () => true
    })
    return !result.survived
  } catch {
    return false
  }
}

/** Stops every process carrying this lease's tag, wherever it was reparented, then proves none
 *  is left. Any own process whose environment couldn't be read, or a target seen alive and later
 *  unreadable, leaves it unproven. */
async function stopTaggedProcesses(
  serverPid: number,
  leaseId: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  try {
    const first = await scanCodexLeaseProcesses(CODEX_SHARED_LEASE_ENV, serverPid, platform)
    if (!first) {
      return false
    }
    const targets = first.tagged(leaseId)
    if (targets.length > 0) {
      // Signalled only if a second reading still shows the tag, so a reused pid is never hit.
      const confirm = await scanCodexLeaseProcesses(CODEX_SHARED_LEASE_ENV, serverPid, platform)
      const still = new Set(confirm?.tagged(leaseId) ?? [])
      for (const pid of targets) {
        if (still.has(pid)) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, SWEEP_SETTLE_MS))
    }
    const after =
      targets.length > 0
        ? await scanCodexLeaseProcesses(CODEX_SHARED_LEASE_ENV, serverPid, platform)
        : first
    if (!after || after.unreadable.length > 0 || after.tagged(leaseId).length > 0) {
      return false
    }
    // A target the last reading didn't list must really be gone, not merely unreadable now.
    return targets.every((pid) => !isAlive(pid))
  } catch {
    return false
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errnoCodeOrUnknown(error) === 'EPERM'
  }
}
