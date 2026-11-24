import { enumerateHostProcesses, readExecutableNames } from '../../../memory/host-process-index'
import { collectSubtree, type ProcIndex } from '../../../memory/process-index'
import type { CodexSharedServer } from './codex-shared-server'

/** Above this a server takes no new chats and stops once its chats leave. */
export const CODEX_SHARED_SERVER_MEMORY_CEILING_BYTES = 1.5 * 1024 * 1024 * 1024
/** The ceiling only steers where new chats go, so it is sampled when a chat joins, at most this often. */
const SAMPLE_MIN_AGE_MS = 60_000

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
  // Windows keeps a dead parent's pid, so a reused pid can close a cycle.
  const seen = new Set<number>()
  while (queue.length > 0) {
    const pid = queue.pop()!
    const row = index.byPid.get(pid)
    if (!row || seen.has(pid)) {
      continue
    }
    seen.add(pid)
    total += row.memory
    if (/^codex/i.test(row.name ?? '')) {
      foundCodex = true
    } else {
      // A child older than its parent hangs off a dead parent whose pid was reused.
      const born = row.startTicks
      const children = index.childrenOf.get(pid) ?? []
      for (const child of children) {
        // Looked up only where Windows gives start times; macOS and Linux keep every child.
        const childBorn = born === undefined ? undefined : index.byPid.get(child)?.startTicks
        if (born === undefined || childBorn === undefined || childBorn >= born) {
          queue.push(child)
        }
      }
    }
  }
  return foundCodex ? total : null
}
