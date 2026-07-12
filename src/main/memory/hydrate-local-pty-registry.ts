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
import { splitWorktreeId } from '../../shared/worktree-id'
import type { Store } from '../persistence'

// Why: `attachMainWindowServices` runs on every macOS dock re-activation
// (see `app.on('activate', ...)` in src/main/index.ts), so this module
// guards against re-running git I/O + daemon RPC after the first pass.
// Stays false until we actually have a daemon provider, so a boot where
// the daemon socket isn't up yet remains retry-eligible on later
// re-activations.
let hasHydrated = false

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
export async function hydrateLocalPtyRegistryAtBoot(store: Pick<Store, 'getRepos'>): Promise<void> {
  try {
    if (hasHydrated) {
      return
    }
    const provider = getDaemonProvider()
    if (!provider) {
      // Why: leave hasHydrated false so a later activation (after the
      // daemon comes up) can retry.
      return
    }
    // Why: flip only once we have a provider — committed to either
    // succeeding or failing on a daemon RPC. Retrying after an RPC
    // throw uses the same socket and is unlikely to help; the
    // renderer-side union still covers that case.
    hasHydrated = true

    // Why: ask the daemon which repos matter before launching Git worktree
    // enumeration. Most configured repos have no preserved session at boot,
    // so scanning all of them creates pure background subprocess churn.
    const reposById = new Map(store.getRepos().map((repo) => [repo.id, repo]))
    // Why: live git enumeration verifies that a referenced local worktree
    // still exists instead of resurrecting removed worktrees.
    const liveLocalWorktreeIds = new Set<string>()
    const resolvedRepoIds = new Set<string>()

    let sessionInfos = await collectSessionInfos(provider)
    let alreadyRegistered = new Set(listRegisteredPtys().map((p) => p.ptyId))

    // Why: repo selection and registration must come from the same daemon
    // snapshot. Git enumeration can take seconds, so after each scan pass we
    // re-read daemon and registry state; sessions that exited or were
    // authoritatively registered meanwhile are not resurrected or overwritten,
    // and a session that only became visible during a slow scan (e.g. a
    // briefly unreachable legacy adapter) gets its repo scanned on the next
    // pass instead of being silently dropped. Terminates because every pass
    // permanently resolves at least one new repo id.
    for (;;) {
      const newlyReferencedRepos = new Map<string, ReturnType<(typeof store)['getRepos']>[number]>()
      for (const info of sessionInfos) {
        if (alreadyRegistered.has(info.sessionId)) {
          continue
        }
        const { worktreeId } = parsePtySessionId(info.sessionId)
        const parsedWorktreeId = worktreeId ? splitWorktreeId(worktreeId) : null
        if (!parsedWorktreeId || resolvedRepoIds.has(parsedWorktreeId.repoId)) {
          continue
        }
        const repo = reposById.get(parsedWorktreeId.repoId)
        if (!repo || (repo.connectionId ?? null)) {
          // Why: unknown repos can't be proven local, and SSH PTYs are never
          // registered for local process sampling — resolve without git
          // enumeration so neither can extend the loop.
          resolvedRepoIds.add(parsedWorktreeId.repoId)
          continue
        }
        newlyReferencedRepos.set(repo.id, repo)
      }
      if (newlyReferencedRepos.size === 0) {
        break
      }

      for (const repo of newlyReferencedRepos.values()) {
        resolvedRepoIds.add(repo.id)
        const worktrees = await listRepoWorktrees(repo)
        for (const wt of worktrees) {
          liveLocalWorktreeIds.add(`${repo.id}::${wt.path}`)
        }
      }

      sessionInfos = await collectSessionInfos(provider)
      alreadyRegistered = new Set(listRegisteredPtys().map((p) => p.ptyId))
    }
    for (const info of sessionInfos) {
      // Why: pid-write ordering — `pty:spawn` is the authoritative
      // writer for in-session sessions; if that fired before this loop
      // started, we must not overwrite a known-good pid with a stale one
      // from listSessions(). Skip if the entry already exists.
      if (alreadyRegistered.has(info.sessionId)) {
        continue
      }
      const { worktreeId } = parsePtySessionId(info.sessionId)
      if (!worktreeId) {
        continue
      }
      // Why: SSH sessions must stay out of the registry — mirrors the
      // spawn-time `if (!args.connectionId)` gate around `registerPty` in
      // `src/main/ipc/pty.ts`. If the repo isn't in the store, skip the
      // session: we can't prove it's local, and the renderer-side union
      // still surfaces the session at the cost of a missing pid sample.
      if (!liveLocalWorktreeIds.has(worktreeId)) {
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
  provider: DaemonPtyRouter | DaemonPtyAdapter | DegradedDaemonPtyProvider
): Promise<SessionInfo[]> {
  // Why: the router fans `listSessions` out across current + legacy adapters
  // so we get every protocol-version daemon's sessions; the bare-adapter
  // fallback is only the in-process restart edge case.
  const adapters: readonly DaemonPtyAdapter[] =
    provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider
      ? provider.getAllAdapters()
      : [provider]
  const out: SessionInfo[] = []
  for (const adapter of adapters) {
    try {
      const sessions = await adapter.listSessions()
      // Why: warm reattach can discover many daemon sessions at once; spreading
      // listSessions() into push can exceed JavaScript's argument limit.
      for (const session of sessions) {
        out.push(session)
      }
    } catch (err) {
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
