import { readFile } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { enumerateHostProcesses, readExecutableNames } from '../../../memory/host-process-index'
import type { ProcIndex } from '../../../memory/process-index'
import { spawnTokenFromEnvironBlock } from '../../../runtime/agent-session/ownership/agent-session-spawn-token-readback'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import { isCodexAppServerUnsupportedError } from '../codex-app-server-session'
import {
  listCodexThreadBackgroundTerminals,
  terminateCodexBackgroundTerminals
} from '../../structured/background-work/codex-background-terminals'
import { CODEX_SHARED_LEASE_ENV } from './codex-shared-server-lease-requests'

const SWEEP_SETTLE_MS = 1_000
const PS_TIMEOUT_MS = 5_000

export type CodexSharedServerProcessSweep = (serverPid: number, leaseId: string) => Promise<boolean>

/** A process's lease tag: its value, absent, or unreadable (which proves nothing). */
type LeaseTag = string | null | 'unknown'

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

/** Processes under the server not yet proven to belong to someone else. */
async function candidates(
  serverPid: number,
  leaseId: string,
  platform: NodeJS.Platform
): Promise<{ mine: number[]; unknown: number } | null> {
  const index = await enumerateHostProcesses({ trackCpu: false, withNames: true })
  // An empty or failed sweep can't show the server, so it proves nothing.
  if (!index.byPid.has(serverPid)) {
    return null
  }
  const codex = await codexProcessUnder(index, serverPid)
  if (codex === null) {
    return null
  }
  // Commands run under Codex itself; the launcher chain above it is the server, not a chat's work.
  const descendants = descendantsOf(index, codex)
  const tags = await readLeaseTags(descendants, platform)
  const mine: number[] = []
  let unknown = 0
  for (const pid of descendants) {
    const tag = tags.get(pid) ?? 'unknown'
    if (tag === leaseId) {
      mine.push(pid)
    } else if (tag === 'unknown') {
      unknown += 1
    }
  }
  return { mine, unknown }
}

async function codexProcessUnder(index: ProcIndex, root: number): Promise<number | null> {
  const rows = [root, ...descendantsOf(index, root)].flatMap((pid) => {
    const row = index.byPid.get(pid)
    return row && row.name === undefined ? [row] : []
  })
  await readExecutableNames(rows)
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (/^codex/i.test(index.byPid.get(pid)?.name ?? '')) {
      return pid
    }
    queue.push(...(index.childrenOf.get(pid) ?? []))
  }
  return null
}

function descendantsOf(index: ProcIndex, root: number): number[] {
  const found: number[] = []
  const queue = [...(index.childrenOf.get(root) ?? [])]
  while (queue.length > 0) {
    const pid = queue.pop()!
    found.push(pid)
    queue.push(...(index.childrenOf.get(pid) ?? []))
  }
  return found
}

/** Proven only when the sweep saw the server and no process under it carries this lease's tag or
 *  hides its tag. Where tags can't be read (Windows), any command under the server leaves it
 *  unproven, so another chat's running command makes this one's Stop unconfirmed, not falsely sure. */
async function stopTaggedProcesses(
  serverPid: number,
  leaseId: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  try {
    const first = await candidates(serverPid, leaseId, platform)
    if (!first) {
      return false
    }
    if (first.mine.length > 0) {
      const confirmed = await readLeaseTags(first.mine, platform)
      for (const pid of first.mine) {
        // Re-read just before signalling, so a reused pid is never hit.
        if (confirmed.get(pid) === leaseId) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, SWEEP_SETTLE_MS))
    }
    const after = first.mine.length > 0 ? await candidates(serverPid, leaseId, platform) : first
    return after !== null && after.mine.length === 0 && after.unknown === 0
  } catch {
    return false
  }
}

async function readLeaseTags(
  pids: readonly number[],
  platform: NodeJS.Platform
): Promise<Map<number, LeaseTag>> {
  const tags = new Map<number, LeaseTag>()
  if (pids.length === 0) {
    return tags
  }
  if (platform === 'linux') {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const block = await readFile(`/proc/${pid}/environ`, 'utf-8')
          tags.set(pid, spawnTokenFromEnvironBlock(block, CODEX_SHARED_LEASE_ENV))
        } catch {
          tags.set(pid, 'unknown')
        }
      })
    )
    return tags
  }
  if (platform === 'darwin') {
    // `ps -E` appends each own-user process's environment to its command line.
    const result = await runProcess({
      program: 'ps',
      args: ['-E', '-ww', '-o', 'pid=,command=', '-p', pids.join(',')],
      timeoutMs: PS_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    }).catch(() => null)
    if (!result || result.timedOut || result.outputTruncated) {
      return tags
    }
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (!match) {
        continue
      }
      const tag = new RegExp(`\\s${CODEX_SHARED_LEASE_ENV}=(\\S+)`).exec(match[2]!)
      tags.set(Number(match[1]), tag ? tag[1]! : null)
    }
    return tags
  }
  return tags
}
