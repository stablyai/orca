import { runProcess } from '@orca/process-host'
import { scanAgentSessionSpawnTokenProcesses } from '../../../runtime/agent-session/ownership/agent-session-spawn-token-process-scan'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import { isCodexAppServerUnsupportedError } from '../codex-app-server-session'
import {
  listCodexThreadBackgroundTerminals,
  terminateCodexBackgroundTerminals
} from '../../structured/background-work/codex-background-terminals'
import { CODEX_SHARED_LEASE_ENV } from './codex-shared-server-lease-requests'

const SWEEP_SETTLE_MS = 1_000
const PS_TIMEOUT_MS = 5_000
const PS_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

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

/** Every process on the host carrying this lease's tag, wherever it was reparented; null when
 *  the host's processes can't all be read (which proves nothing). */
async function findTagged(leaseId: string, platform: NodeJS.Platform): Promise<number[] | null> {
  if (platform === 'linux') {
    const scan = await scanAgentSessionSpawnTokenProcesses('linux', CODEX_SHARED_LEASE_ENV)
    return scan ? [...(scan.get(leaseId) ?? [])] : null
  }
  if (platform !== 'darwin') {
    return null
  }
  // `ps -E` appends each own-user process's environment to its command line; others show none,
  // and a chat's commands always run as this user.
  const result = await runProcess({
    program: 'ps',
    args: ['-E', '-ww', '-A', '-o', 'pid=,command='],
    timeoutMs: PS_TIMEOUT_MS,
    maxOutputBytes: PS_MAX_OUTPUT_BYTES,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  }).catch(() => null)
  if (!result || result.timedOut || result.outputTruncated || result.code !== 0) {
    return null
  }
  const tag = ` ${CODEX_SHARED_LEASE_ENV}=${leaseId}`
  const tagged: number[] = []
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s/.exec(line)
    const rest = match ? line.slice(match[0].length - 1) : ''
    if (match && (rest.includes(`${tag} `) || rest.endsWith(tag))) {
      tagged.push(Number(match[1]))
    }
  }
  return tagged
}

/** Stops every process carrying this lease's tag, then proves none is left. Windows can't read a
 *  process's environment, so it never proves this (the pool isn't used there). */
async function stopTaggedProcesses(
  _serverPid: number,
  leaseId: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  try {
    const found = await findTagged(leaseId, platform)
    if (found === null) {
      return false
    }
    if (found.length === 0) {
      return true
    }
    // Re-read just before signalling, so a reused pid is never hit.
    const confirmed = new Set((await findTagged(leaseId, platform)) ?? [])
    for (const pid of found) {
      if (confirmed.has(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, SWEEP_SETTLE_MS))
    const after = await findTagged(leaseId, platform)
    return after !== null && after.length === 0
  } catch {
    return false
  }
}
