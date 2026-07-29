/**
 * Boot-time hydration of `pty-registry` from the live daemon.
 *
 * Why: on warm reattach (fresh Orca process, still-running daemon) the renderer
 * hasn't re-mounted every pane, so `pty:spawn` never fired for those sessions
 * and they surfaced as "REMOTE" despite being local. Fill the gap once at boot,
 * registering only sessions whose repo has no `connectionId` — mirroring the
 * spawn-time gate in `src/main/ipc/pty.ts`.
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

// Why: attachMainWindowServices reruns on every macOS dock re-activation; guard against re-running git I/O + daemon RPC.
let hasHydrated = false

/**
 * Read the live daemon session list and register every local session the
 * registry doesn't already know about.
 *
 * Why: failures here are a coverage degradation (the renderer-side union still
 * covers the gap), not a correctness regression, so they're swallowed.
 */
export async function hydrateLocalPtyRegistryAtBoot(store: Pick<Store, 'getRepos'>): Promise<void> {
  try {
    if (hasHydrated) {
      return
    }
    const provider = getDaemonProvider()
    if (!provider) {
      // Why: leave hasHydrated false so a later activation can retry once the daemon is up.
      return
    }
    // Why: flip only after a provider exists; retrying a failed RPC on the same socket won't help.
    hasHydrated = true

    // Why: defer git worktree enumeration to only repos with a live session; scanning all repos is background subprocess churn.
    const reposById = new Map(store.getRepos().map((repo) => [repo.id, repo]))
    // Why: verify via live git that a referenced worktree still exists, to avoid resurrecting removed ones.
    const liveLocalWorktreeIds = new Set<string>()
    const resolvedRepoIds = new Set<string>()

    let sessionInfos = await collectSessionInfos(provider)
    let alreadyRegistered = new Set(listRegisteredPtys().map((p) => p.ptyId))

    // Why: git enumeration is slow, so re-read daemon+registry each pass to avoid resurrecting exited sessions; terminates as each pass resolves >=1 new repo.
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
          // Why: unknown or SSH repos can't be proven local; resolve without git enumeration so they can't extend the loop.
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
      // Why: pty:spawn is the authoritative pid writer; don't overwrite its entry with a stale listSessions() pid.
      if (alreadyRegistered.has(info.sessionId)) {
        continue
      }
      const { worktreeId } = parsePtySessionId(info.sessionId)
      if (!worktreeId) {
        continue
      }
      // Why: only register proven-local worktrees, mirroring the spawn-time !connectionId gate in src/main/ipc/pty.ts.
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
  // Why: fan listSessions across current + legacy adapters so no daemon protocol version is missed.
  const adapters: readonly DaemonPtyAdapter[] =
    provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider
      ? provider.getAllAdapters()
      : [provider]
  const out: SessionInfo[] = []
  for (const adapter of adapters) {
    try {
      const sessions = await adapter.listSessions()
      // Why: session count can exceed the JS argument limit, so avoid push(...sessions).
      for (const session of sessions) {
        out.push(session)
      }
    } catch (err) {
      // Why: one adapter's socket being unreachable is normal; don't abort the others.
      console.warn(
        '[memory] listSessions failed for one adapter during hydration:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  return out
}
