import { readFile } from 'node:fs/promises'
import { enumerateHostProcesses, readExecutableNames } from '../../../memory/host-process-index'
import { collectSubtree, type ProcIndex } from '../../../memory/process-index'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { spawnTokenFromEnvironBlock } from '../../../runtime/agent-session/ownership/agent-session-spawn-token-readback'
import type { CodexSharedServer } from './codex-shared-server'

/** Above this a server takes no new chats and stops once its chats leave. */
export const CODEX_SHARED_SERVER_MEMORY_CEILING_BYTES = 1.5 * 1024 * 1024 * 1024
/** The ceiling only steers where new chats go, so it is sampled when a chat joins, at most this often. */
const SAMPLE_MIN_AGE_MS = 60_000

export type CodexSharedServerToolUsage = {
  sessionId: string
  pids: number[]
  cpu: number
  memory: number
}

/** No timer: a chat joining a pool triggers at most one host process sweep a minute. */
export class CodexSharedServerMemoryCeiling {
  private lastSampleAt = Number.NEGATIVE_INFINITY
  private sampling = false

  constructor(
    private readonly servers: () => CodexSharedServer[],
    private readonly onDraining: (server: CodexSharedServer) => void,
    private readonly ceilingBytes = CODEX_SHARED_SERVER_MEMORY_CEILING_BYTES
  ) {}

  /** In the background: this join goes where the last sample said; later ones see this one. */
  sampleIfStale(now = Date.now()): void {
    if (
      this.sampling ||
      now - this.lastSampleAt < SAMPLE_MIN_AGE_MS ||
      this.servers().length === 0
    ) {
      return
    }
    this.lastSampleAt = now
    void this.sample()
  }

  async sample(index?: ProcIndex): Promise<void> {
    if (this.sampling) {
      return
    }
    this.sampling = true
    try {
      const processes =
        index ?? (await enumerateHostProcesses({ trackCpu: false, withNames: true }))
      // Linux sweeps carry no names; read them for the servers' trees, or the walk can't stop at Codex.
      await readExecutableNames(
        this.servers().flatMap((server) =>
          server.pid === undefined
            ? []
            : collectSubtree(processes, server.pid).flatMap((pid) => {
                const row = processes.byPid.get(pid)
                return row && row.name === undefined ? [row] : []
              })
        )
      )
      for (const server of this.servers()) {
        const pid = server.pid
        const memory = pid === undefined ? null : codexServerOwnMemory(processes, pid)
        server.memoryBytes = memory
        server.toolUsage =
          pid === undefined ? [] : await attributeCodexSharedServerTools(processes, pid)
        if (!server.draining && memory !== null && memory > this.ceilingBytes) {
          server.draining = true
          console.warn(
            `[codex-shared-server] pid ${pid} uses ${Math.round(memory / 1048576)} MiB; new chats go to a fresh server`
          )
          this.onDraining(server)
        }
      }
    } catch (error) {
      console.warn('[codex-shared-server] memory sample failed', error)
    } finally {
      this.sampling = false
    }
  }
}

/** The launcher chain down to the native codex process, without the tools it runs; null when no
 *  process in the tree is named codex, rather than counting its tools as the server. */
export function codexServerOwnMemory(index: ProcIndex, rootPid: number): number | null {
  if (!index.byPid.has(rootPid)) {
    return null
  }
  let total = 0
  let foundCodex = false
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.pop()!
    const row = index.byPid.get(pid)
    if (!row) {
      continue
    }
    total += row.memory
    if (/^codex/i.test(row.name ?? '')) {
      foundCodex = true
    } else {
      queue.push(...(index.childrenOf.get(pid) ?? []))
    }
  }
  return foundCodex ? total : null
}

/** Codex runs each chat's commands with that chat's ORCA_AGENT_SESSION_ID (shell_environment_policy),
 *  so a shared server's tool processes attribute to their chat. Linux only: elsewhere a process's
 *  environment isn't readable cheaply, and those rows stay with the server. */
export async function attributeCodexSharedServerTools(
  index: ProcIndex,
  serverPid: number,
  platform: NodeJS.Platform = process.platform
): Promise<CodexSharedServerToolUsage[]> {
  if (platform !== 'linux') {
    return []
  }
  const bySession = new Map<string, CodexSharedServerToolUsage>()
  for (const pid of collectSubtree(index, serverPid)) {
    const row = index.byPid.get(pid)
    if (!row || pid === serverPid) {
      continue
    }
    let sessionId: string | null = null
    try {
      sessionId = spawnTokenFromEnvironBlock(
        await readFile(`/proc/${pid}/environ`, 'utf-8'),
        ORCA_AGENT_SESSION_ID_ENV
      )
    } catch {
      continue
    }
    if (!sessionId) {
      continue
    }
    const usage = bySession.get(sessionId) ?? { sessionId, pids: [], cpu: 0, memory: 0 }
    usage.pids.push(pid)
    usage.cpu += row.cpu
    usage.memory += row.memory
    bySession.set(sessionId, usage)
  }
  return [...bySession.values()]
}
