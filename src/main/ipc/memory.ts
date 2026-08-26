import { app, ipcMain } from 'electron'
import type { MemorySnapshot } from '../../shared/process-stats-types'
import type { Store } from '../persistence'
import { collectMemorySnapshot } from '../memory/collector'
import { parseRemoteMemorySnapshot } from '../memory/remote-memory-snapshot'
import { getRemoteTerminalTitles } from '../memory/remote-terminal-titles'
import { parseExecutionHostId } from '../../shared/execution-host'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

export type MemorySnapshotRequest = { executionHostId?: string | null }

// Why: outer bound only — deliberately longer than the transport's own 15s
// timeout so a healthy-but-slow host still answers on its normal path. This
// catches the stalls that timeout does not cover, such as waiting behind the
// per-environment call queue.
const RUNTIME_SNAPSHOT_DEADLINE_MS = 20_000

/**
 * Hard deadline around the transport. Calls to one environment are serialized, so
 * a request that never settles would wedge every later poll behind it — which is
 * why the deadline aborts the call rather than only rejecting this caller.
 */
async function withDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('runtime_unreachable'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([start(controller.signal), expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Remote runtimes already collect their own snapshot; this proxies to the one
 * the caller asked for. Failures reject rather than degrading to a local or
 * empty snapshot: an unreachable host is unverifiable, not idle, and the panel
 * must say so instead of drawing a remote machine as 0%.
 */
async function collectRuntimeSnapshot(environmentId: string): Promise<MemorySnapshot> {
  const response = await withDeadline(
    (signal) =>
      callRuntimeEnvironment(
        app.getPath('userData'),
        environmentId,
        'diagnostics.memory',
        null,
        undefined,
        undefined,
        undefined,
        { signal }
      ),
    RUNTIME_SNAPSHOT_DEADLINE_MS
  )
  if (!response.ok) {
    throw new Error(response.error.message || response.error.code || 'runtime_unavailable')
  }
  const snapshot = parseRemoteMemorySnapshot(response.result)
  if (!snapshot) {
    throw new Error('runtime_snapshot_unsupported')
  }
  return withRemoteSessionTitles(snapshot, environmentId)
}

/**
 * A remote snapshot names its sessions by pty id, which the panel would render as
 * `pid <n>`. The host knows the real names, so fold them in here. Titles are a
 * nicety: this never rejects, and a host that cannot answer keeps the pid labels.
 */
async function withRemoteSessionTitles(
  snapshot: MemorySnapshot,
  environmentId: string
): Promise<MemorySnapshot> {
  const titles = await getRemoteTerminalTitles(app.getPath('userData'), environmentId)
  if (titles.size === 0) {
    return snapshot
  }
  return {
    ...snapshot,
    worktrees: snapshot.worktrees.map((worktree) => ({
      ...worktree,
      sessions: worktree.sessions.map((session) => {
        const title = titles.get(session.sessionId)
        return title ? { ...session, title } : session
      })
    }))
  }
}

export function registerMemoryHandlers(store: Store): void {
  ipcMain.handle(
    'memory:getSnapshot',
    (_event, request?: MemorySnapshotRequest): Promise<MemorySnapshot> => {
      const host = parseExecutionHostId(request?.executionHostId)
      if (host?.kind === 'runtime') {
        return collectRuntimeSnapshot(host.environmentId)
      }
      // Why: SSH hosts run PTYs outside any Orca process, so there is nothing to
      // ask; the renderer never offers them, and a stale id must not silently
      // answer with local numbers under a remote label.
      if (host?.kind === 'ssh') {
        return Promise.reject(new Error('resource_host_unsupported'))
      }
      return collectMemorySnapshot(store)
    }
  )
}
