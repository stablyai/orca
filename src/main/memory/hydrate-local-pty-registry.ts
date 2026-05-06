/**
 * Boot-time hydration of `pty-registry` from the live daemon.
 *
 * Why: see docs/resource-usage-remote-mislabel.md §1. The registry is
 * normally populated by the `pty:spawn` IPC handler. On warm reattach
 * (a fresh Orca process bound to a still-running daemon), the renderer
 * hasn't re-mounted every pane yet, so `pty:spawn` hasn't fired for
 * those sessions and the memory collector's snapshot omits them. The
 * renderer then unions in `pty.listSessions()` results with
 * `hasLocalSamples: false`, which the chip predicate rendered as
 * "REMOTE" — even though the sessions are local.
 *
 * This module fills the gap once at boot: ask the daemon for every live
 * session, reattribute each one to its repo via the minted session-id
 * format, and only register sessions whose repo has no `connectionId`
 * (i.e. truly local). Truly remote (SSH) sessions stay out of the
 * registry, mirroring the spawn-time gate at `pty.ts:1005`.
 */

import { getDaemonProvider } from '../daemon/daemon-init'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import type { SessionInfo } from '../daemon/types'
import { listRegisteredPtys, registerPty } from './pty-registry'
import { listRepoWorktrees } from '../repo-worktrees'
import { parsePtySessionId } from '../../shared/pty-session-id-format'
import type { Store } from '../persistence'

// Why: `attachMainWindowServices` runs on every macOS dock re-activation
// (see `app.on('activate', ...)` in src/main/index.ts), so this module
// guards against re-running git I/O + daemon RPC after the first pass.
let hasHydrated = false

/**
 * Read the live daemon session list and register every local session
 * the registry doesn't already know about.
 *
 * Once-per-process: subsequent calls are a no-op. `attachMainWindowServices`
 * fires on every macOS dock re-activation, so the module-level
 * `hasHydrated` guard ensures the git-worktree enumeration and
 * `reconcileOnStartup` daemon RPC only run on the first invocation.
 *
 * Wrapped in `try/catch` because the daemon socket may be unreachable
 * at boot (process not yet started, or just died); the renderer-side
 * union still covers that case until the daemon comes back. Any failure
 * here is a coverage degradation, not a correctness regression.
 */
export async function hydrateLocalPtyRegistryAtBoot(store: Store): Promise<void> {
  try {
    if (hasHydrated) {
      return
    }
    hasHydrated = true
    const provider = getDaemonProvider()
    if (!provider) {
      return
    }

    // Why: build the same valid-worktree set scheduleHistoryGc uses, so
    // reconcileOnStartup can prune sessions whose repo or worktree no
    // longer exists. Reuses git I/O the GC pass would do anyway 10s
    // later.
    const repos = store.getRepos()
    const validWorktreeIds = new Set<string>()
    const repoConnectionIdByWorktreeId = new Map<string, string | null>()

    for (const repo of repos) {
      const worktrees = await listRepoWorktrees(repo)
      const connectionId = repo.connectionId ?? null
      for (const wt of worktrees) {
        const worktreeId = `${repo.id}::${wt.path}`
        validWorktreeIds.add(worktreeId)
        repoConnectionIdByWorktreeId.set(worktreeId, connectionId)
      }
    }

    const { alive } = await provider.reconcileOnStartup(validWorktreeIds)

    // Why: getActiveSessionIds() / SessionInfo are read through the
    // adapter's listSessions() so we get the pid alongside each id.
    // Routing through every adapter (current + legacy) keeps protocol
    // coverage symmetric with reconcileOnStartup.
    const sessionInfos = await collectSessionInfos(provider)
    const aliveSet = new Set(alive)

    const alreadyRegistered = new Set(listRegisteredPtys().map((p) => p.ptyId))

    for (const info of sessionInfos) {
      if (!aliveSet.has(info.sessionId)) {
        continue
      }
      // Why: pid-write ordering — `pty:spawn` is the authoritative
      // writer for in-session sessions; if that fired between
      // reconcileOnStartup and this loop, we must not overwrite a
      // known-good pid with a stale one from listSessions(). Skip if
      // the entry already exists. See doc §1d.
      if (alreadyRegistered.has(info.sessionId)) {
        continue
      }
      const { worktreeId } = parsePtySessionId(info.sessionId)
      if (!worktreeId) {
        continue
      }
      // Why: SSH sessions must stay out of the registry — mirrors the
      // spawn-time gate at `pty.ts:1005`. If the repo isn't in the
      // store at all, treat it as local-unknown rather than remote: the
      // worst outcome is a pid we can't sample, which the collector
      // already handles.
      if (!repoConnectionIdByWorktreeId.has(worktreeId)) {
        continue
      }
      if (repoConnectionIdByWorktreeId.get(worktreeId)) {
        continue
      }
      registerPty({
        ptyId: info.sessionId,
        worktreeId,
        sessionId: info.sessionId,
        paneKey: null,
        pid:
          typeof info.pid === 'number' && Number.isFinite(info.pid) && info.pid > 0
            ? info.pid
            : null
      })
    }
  } catch (err) {
    console.warn(
      '[memory] Boot-time pty-registry hydration failed:',
      err instanceof Error ? err.message : String(err)
    )
  }
}

async function collectSessionInfos(
  provider: DaemonPtyRouter | DaemonPtyAdapter
): Promise<SessionInfo[]> {
  // Why: the router fans `listSessions` out across current + legacy adapters
  // so we get every protocol-version daemon's sessions; the bare-adapter
  // fallback is only the in-process restart edge case.
  const adapters: readonly DaemonPtyAdapter[] =
    provider instanceof DaemonPtyRouter ? provider.getAllAdapters() : [provider]
  const out: SessionInfo[] = []
  for (const adapter of adapters) {
    try {
      const sessions = await adapter.listSessions()
      out.push(...sessions)
    } catch {
      // Why: a single adapter failing should not abort hydration of the
      // others — the current adapter and any legacy daemons each have
      // their own socket and one being unreachable is normal.
    }
  }
  return out
}
