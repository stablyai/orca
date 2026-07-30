import type { IPtyProvider } from '../providers/types'
import type { Repo } from '../../shared/types'
import { splitWorktreeId } from '../../shared/worktree-id'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type { OrcaRuntimeService } from './orca-runtime'
import { killAllProcessesForWorktree } from './worktree-teardown'

const MISSING_WORKTREE_TEARDOWN_CONCURRENCY = 4

// Why: every worktree in one sweep is already known-missing, so they can all be
// served by a single point-in-time process list. Without this, an agent that
// deletes N workspaces costs N full host enumerations — O(N) relay round-trips
// carrying O(N^2) rows, which is minutes of stalled teardown on a remote host.
//
// Safe only because this sweep is best-effort. Do NOT reuse this wrapper on a
// `requirePhysicalStop` path: that re-lists *after* shutdown to prove a PTY
// exited, and a pre-shutdown snapshot would make the proof read stale rows.
function withSharedProcessSnapshot(provider: IPtyProvider): IPtyProvider {
  let snapshot: Promise<Awaited<ReturnType<IPtyProvider['listProcesses']>>> | null = null
  return new Proxy(provider, {
    get(target, property) {
      if (property !== 'listProcesses') {
        // Why: bind other members to `target`, not the proxy. With the proxy as
        // receiver, a provider whose own method called `this.listProcesses()`
        // would silently read this sweep's cached snapshot instead of the live
        // host — the batching must not leak past the calls it was built for.
        const member: unknown = Reflect.get(target, property)
        return typeof member === 'function' ? member.bind(target) : member
      }
      return async (opts?: { deadlineMs?: number }) => {
        const pending = (snapshot ??= target.listProcesses(opts))
        try {
          return await pending
        } catch {
          // Why: a shared *rejection* would let one transient relay failure suppress
          // the provider sweep for every worktree in the batch — the exact leak this
          // reconciliation exists to prevent. Failures fall back to a per-caller scan,
          // restoring pre-batching isolation while success still costs one round-trip.
          if (snapshot === pending) {
            snapshot = null
          }
          return target.listProcesses(opts)
        }
      }
    }
  })
}

type MissingWorktreeTerminalReconciliationDeps = {
  runtime: OrcaRuntimeService
  getLocalProvider: () => IPtyProvider | null
  getSshProvider: (connectionId: string) => IPtyProvider | undefined
  onPtyStopped?: (ptyId: string) => void
}

export async function stopMissingWorktreeTerminals(
  repo: Repo,
  knownWorktreeIds: readonly string[],
  detectedWorktreeIds: readonly string[],
  deps: MissingWorktreeTerminalReconciliationDeps
): Promise<{ stoppedWorktreeIds: string[] }> {
  const detectedIds = new Set(detectedWorktreeIds)
  const missingIds = [
    ...new Set(
      knownWorktreeIds.filter(
        (worktreeId) =>
          splitWorktreeId(worktreeId)?.repoId === repo.id && !detectedIds.has(worktreeId)
      )
    )
  ]
  if (missingIds.length === 0) {
    return { stoppedWorktreeIds: [] }
  }

  const ownedProvider = repo.connectionId
    ? deps.getSshProvider(repo.connectionId)
    : deps.getLocalProvider()
  const provider = ownedProvider ? withSharedProcessSnapshot(ownedProvider) : ownedProvider
  if (!provider) {
    const stoppedWorktreeIds = (
      await mapWithConcurrency(
        missingIds,
        MISSING_WORKTREE_TEARDOWN_CONCURRENCY,
        async (worktreeId) => {
          try {
            await deps.runtime.stopTerminalsForWorktree(worktreeId)
            return worktreeId
          } catch {
            return null
          }
        }
      )
    ).filter((worktreeId): worktreeId is string => worktreeId !== null)
    return { stoppedWorktreeIds }
  }

  const stoppedWorktreeIds = (
    await mapWithConcurrency(
      missingIds,
      MISSING_WORKTREE_TEARDOWN_CONCURRENCY,
      async (worktreeId) => {
        try {
          await killAllProcessesForWorktree(worktreeId, {
            runtime: deps.runtime,
            localProvider: provider,
            onPtyStopped: deps.onPtyStopped,
            // Why: the shared process snapshot is only valid while nothing needs a
            // post-shutdown re-list, so this sweep stays explicitly best-effort.
            requirePhysicalStop: false,
            ...(repo.connectionId ? { includeLocalRegistry: false } : {})
          })
          return worktreeId
        } catch (error) {
          console.warn(`[worktree-teardown] Failed to stop missing workspace ${worktreeId}`, error)
          return null
        }
      }
    )
  ).filter((worktreeId): worktreeId is string => worktreeId !== null)

  return { stoppedWorktreeIds }
}
