/**
 * Boot-time hydration of `pty-registry` from the live daemon.
 *
 * Why: the registry is normally populated by the `pty:spawn` IPC
 * handler. On warm reattach (a fresh Orca process bound to a
 * still-running daemon), the renderer hasn't re-mounted every pane
 * yet, so `pty:spawn` hasn't fired for those sessions and the memory
 * collector's snapshot omits them. The renderer then unions in
 * `pty.listSessions()` results with `hasLocalSamples: false`, which
 * the chip predicate rendered as "REMOTE" — even though the sessions
 * are local.
 *
 * This module fills the gap once at boot: ask the daemon for every live
 * session, reattribute each one to its repo via the minted session-id
 * format, and only register sessions whose repo has no `connectionId`
 * (i.e. truly local). Truly remote (SSH) sessions stay out of the
 * registry, mirroring the spawn-time gate (the `if (!args.connectionId)` block around the `registerPty` call in `src/main/ipc/pty.ts`).
 */

import { getDaemonProvider } from '../daemon/daemon-init'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import type { SessionInfo } from '../daemon/types'
import { listRegisteredPtys, registerPty } from './pty-registry'
import { listRepoWorktrees } from '../repo-worktrees'
import { parsePtySessionId } from '../../shared/pty-session-id-format'
import type { Store } from '../persistence'
import type { WorktreeMeta } from '../../shared/types'

// Why: `attachMainWindowServices` runs on every macOS dock re-activation
// (see `app.on('activate', ...)` in src/main/index.ts), so this module
// guards against re-running git I/O + daemon RPC after the first pass.
// Stays false until we actually have a daemon provider, so a boot where
// the daemon socket isn't up yet remains retry-eligible on later
// re-activations.
let hasHydrated = false

export type LocalPtyRegistryHydrationDebugSnapshot = {
  phase: 'not-started' | 'provider-unavailable' | 'running' | 'complete' | 'partial' | 'failed'
  hasHydrated: boolean
  startedAtMs: number | null
  finishedAtMs: number | null
  elapsedMs: number | null
  repoCount: number
  localRepoCount: number
  skippedRemoteRepoCount: number
  worktreeEnumerationCount: number
  worktreeCount: number
  adapterCount: number
  sessionsScannedCount: number
  registeredCount: number
  alreadyRegisteredCount: number
  skippedUnparseableCount: number
  skippedUnknownWorktreeCount: number
  skippedRemoteWorktreeCount: number
  failedAdapterCount: number
}

function emptyHydrationDebugSnapshot(): LocalPtyRegistryHydrationDebugSnapshot {
  return {
    phase: 'not-started',
    hasHydrated: false,
    startedAtMs: null,
    finishedAtMs: null,
    elapsedMs: null,
    repoCount: 0,
    localRepoCount: 0,
    skippedRemoteRepoCount: 0,
    worktreeEnumerationCount: 0,
    worktreeCount: 0,
    adapterCount: 0,
    sessionsScannedCount: 0,
    registeredCount: 0,
    alreadyRegisteredCount: 0,
    skippedUnparseableCount: 0,
    skippedUnknownWorktreeCount: 0,
    skippedRemoteWorktreeCount: 0,
    failedAdapterCount: 0
  }
}

let lastHydrationDebugSnapshot = emptyHydrationDebugSnapshot()

function finishHydrationDebugSnapshot(
  phase: LocalPtyRegistryHydrationDebugSnapshot['phase']
): void {
  const finishedAtMs = Date.now()
  lastHydrationDebugSnapshot = {
    ...lastHydrationDebugSnapshot,
    phase,
    finishedAtMs,
    elapsedMs:
      lastHydrationDebugSnapshot.startedAtMs === null
        ? null
        : Math.max(0, finishedAtMs - lastHydrationDebugSnapshot.startedAtMs)
  }
}

export function getLocalPtyRegistryHydrationDebugSnapshot(): LocalPtyRegistryHydrationDebugSnapshot {
  return { ...lastHydrationDebugSnapshot }
}

/**
 * Read the live daemon session list and register every local session
 * the registry doesn't already know about.
 *
 * Once-per-process when the daemon is reachable on first call:
 * `attachMainWindowServices` fires on every macOS dock re-activation, so
 * the module-level `hasHydrated` guard ensures the git-worktree
 * enumeration and `listSessions` daemon RPC only run on the first
 * successful invocation. If the daemon is offline at first call (no
 * provider yet), the function returns without flipping the flag so a
 * later macOS re-activation can retry; once a provider is obtained the
 * flag flips and subsequent calls are a no-op.
 *
 * Wrapped in `try/catch` because the daemon socket may be unreachable
 * at boot (process not yet started, or just died); the renderer-side
 * union still covers that case until the daemon comes back. Any failure
 * here is a coverage degradation, not a correctness regression.
 */
type HydrationStore = Pick<Store, 'getRepos'> & {
  getWorktreeMeta?: (worktreeId: string) => WorktreeMeta | undefined
}

export async function hydrateLocalPtyRegistryAtBoot(store: HydrationStore): Promise<void> {
  try {
    if (hasHydrated) {
      return
    }
    const provider = getDaemonProvider()
    if (!provider) {
      lastHydrationDebugSnapshot = {
        ...emptyHydrationDebugSnapshot(),
        phase: 'provider-unavailable'
      }
      // Why: leave hasHydrated false so a later activation (after the
      // daemon comes up) can retry.
      return
    }
    // Why: flip only once we have a provider — committed to either
    // succeeding or failing on a daemon RPC. Retrying after an RPC
    // throw uses the same socket and is unlikely to help; the
    // renderer-side union still covers that case.
    hasHydrated = true
    lastHydrationDebugSnapshot = {
      ...emptyHydrationDebugSnapshot(),
      phase: 'running',
      hasHydrated: true,
      startedAtMs: Date.now()
    }

    // Why: build a worktree-id → connectionId map so we can SSH-gate each
    // session before registering. Live git enumeration matches the path
    // shape used by `mintPtySessionId` (`${repoId}::${path}`).
    const repos = store.getRepos()
    lastHydrationDebugSnapshot.repoCount = repos.length
    const repoConnectionIdByWorktreeId = new Map<
      string,
      { connectionId: string | null; currentWorktreeId: string }
    >()

    for (const repo of repos) {
      const connectionId = repo.connectionId ?? null
      if (connectionId) {
        lastHydrationDebugSnapshot.skippedRemoteRepoCount += 1
        // Why: SSH PTYs are never registered for local process sampling, so
        // avoid startup SSH/git enumeration for repos we will skip anyway.
        continue
      }
      lastHydrationDebugSnapshot.localRepoCount += 1
      lastHydrationDebugSnapshot.worktreeEnumerationCount += 1
      const worktrees = await listRepoWorktrees(repo)
      lastHydrationDebugSnapshot.worktreeCount += worktrees.length
      for (const wt of worktrees) {
        const worktreeId = `${repo.id}::${wt.path}`
        repoConnectionIdByWorktreeId.set(worktreeId, {
          connectionId,
          currentWorktreeId: worktreeId
        })
        const priorWorktreeIds = store.getWorktreeMeta?.(worktreeId)?.priorWorktreeIds ?? []
        for (const priorWorktreeId of priorWorktreeIds) {
          repoConnectionIdByWorktreeId.set(priorWorktreeId, {
            connectionId,
            currentWorktreeId: worktreeId
          })
        }
      }
    }

    // Why: SessionInfo is read through the adapter's listSessions() so we
    // get the pid alongside each id. Routing through every adapter
    // (current + legacy) keeps protocol coverage symmetric with the
    // orphan-cleanup path.
    const sessionInfos = await collectSessionInfos(provider, lastHydrationDebugSnapshot)

    const alreadyRegistered = new Set(listRegisteredPtys().map((p) => p.ptyId))

    for (const info of sessionInfos) {
      // Why: pid-write ordering — `pty:spawn` is the authoritative
      // writer for in-session sessions; if that fired before this loop
      // started, we must not overwrite a known-good pid with a stale one
      // from listSessions(). Skip if the entry already exists.
      if (alreadyRegistered.has(info.sessionId)) {
        lastHydrationDebugSnapshot.alreadyRegisteredCount += 1
        continue
      }
      const { worktreeId } = parsePtySessionId(info.sessionId)
      if (!worktreeId) {
        lastHydrationDebugSnapshot.skippedUnparseableCount += 1
        continue
      }
      // Why: SSH sessions must stay out of the registry — mirrors the
      // spawn-time `if (!args.connectionId)` gate around `registerPty` in
      // `src/main/ipc/pty.ts`. If the repo isn't in the store, skip the
      // session: we can't prove it's local, and the renderer-side union
      // still surfaces the session at the cost of a missing pid sample.
      const worktreeRoute = repoConnectionIdByWorktreeId.get(worktreeId)
      if (!worktreeRoute) {
        lastHydrationDebugSnapshot.skippedUnknownWorktreeCount += 1
        continue
      }
      if (worktreeRoute.connectionId) {
        lastHydrationDebugSnapshot.skippedRemoteWorktreeCount += 1
        continue
      }
      registerPty({
        ptyId: info.sessionId,
        worktreeId: worktreeRoute.currentWorktreeId,
        sessionId: info.sessionId,
        paneKey: null,
        pid:
          typeof info.pid === 'number' && Number.isFinite(info.pid) && info.pid > 0
            ? info.pid
            : null
      })
      lastHydrationDebugSnapshot.registeredCount += 1
    }
    finishHydrationDebugSnapshot(
      lastHydrationDebugSnapshot.failedAdapterCount > 0 ? 'partial' : 'complete'
    )
  } catch (err) {
    finishHydrationDebugSnapshot('failed')
    console.warn(
      '[memory] Boot-time pty-registry hydration failed:',
      err instanceof Error ? err.message : String(err)
    )
  }
}

async function collectSessionInfos(
  provider: DaemonPtyRouter | DaemonPtyAdapter | DegradedDaemonPtyProvider,
  debugSnapshot: LocalPtyRegistryHydrationDebugSnapshot
): Promise<SessionInfo[]> {
  // Why: the router fans `listSessions` out across current + legacy adapters
  // so we get every protocol-version daemon's sessions; the bare-adapter
  // fallback is only the in-process restart edge case.
  const providerWithAdapters = provider as { getAllAdapters?: () => readonly DaemonPtyAdapter[] }
  let adapters: readonly DaemonPtyAdapter[]
  if (typeof providerWithAdapters.getAllAdapters === 'function') {
    adapters = providerWithAdapters.getAllAdapters()
  } else if (provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider) {
    adapters = provider.getAllAdapters()
  } else {
    adapters = [provider]
  }
  debugSnapshot.adapterCount = adapters.length
  const out: SessionInfo[] = []
  for (const adapter of adapters) {
    try {
      const sessions = await adapter.listSessions()
      debugSnapshot.sessionsScannedCount += sessions.length
      // Why: warm reattach can discover many daemon sessions at once; spreading
      // listSessions() into push can exceed JavaScript's argument limit.
      for (const session of sessions) {
        out.push(session)
      }
    } catch (err) {
      debugSnapshot.failedAdapterCount += 1
      // Why: a single adapter failing should not abort hydration of the
      // others — the current adapter and any legacy daemons each have
      // their own socket and one being unreachable is normal.
      console.warn(
        '[memory] listSessions failed for one adapter during hydration:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  return out
}
