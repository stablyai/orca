import { getRepoRoutingConnectionId } from '../../shared/execution-host'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { Repo } from '../../shared/repo-types'
import { splitWorktreeId } from '../../shared/worktree/id'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { killAllProcessesForWorktree, type WorktreeTeardownRuntime } from './worktree-teardown'

const MISSING_WORKTREE_TEARDOWN_CONCURRENCY = 4

// Share one snapshot across known-missing workspaces to avoid O(N²) inventory traffic.
// Best-effort only: requirePhysicalStop needs fresh post-shutdown evidence and must never reuse this cache.
function withSharedProcessSnapshot(provider: IPtyProvider): IPtyProvider {
  let snapshot: Promise<Awaited<ReturnType<IPtyProvider['listProcesses']>>> | null = null
  return new Proxy(provider, {
    get(target, property) {
      if (property !== 'listProcesses') {
        // Bind to the real provider so internal this.listProcesses reads live state, not this sweep's cache.
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap default forward.
        const member: unknown = Reflect.get(target, property)
        return typeof member === 'function' ? member.bind(target) : member
      }
      return async (opts?: Parameters<IPtyProvider['listProcesses']>[0]) => {
        const pending = (snapshot ??= target.listProcesses({
          ...opts,
          worktreeId: undefined,
          ptyIds: undefined
        }))
        try {
          return await pending
        } catch {
          // Retry failures per caller so one transient relay error cannot suppress the rest of the sweep.
          if (snapshot === pending) {
            snapshot = null
          }
          return target.listProcesses(opts)
        }
      }
    }
  })
}

// Host-fence path-derived ids so another host's same-id workspace survives.
function hostFence(
  repo: Repo,
  worktreeId: string
): { resolvedWorktreeId: string; resolvedConnectionId?: string } {
  const connectionId = getRepoRoutingConnectionId(repo)
  return {
    resolvedWorktreeId: worktreeId,
    ...(connectionId ? { resolvedConnectionId: connectionId } : {})
  }
}

type MissingWorktreeTerminalReconciliationDeps = {
  runtime: WorktreeTeardownRuntime
  getLocalProvider: () => IPtyProvider | null
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

  const ownedProvider = getRepoRoutingConnectionId(repo) ? null : deps.getLocalProvider()
  const provider = ownedProvider ? withSharedProcessSnapshot(ownedProvider) : ownedProvider
  if (!provider) {
    const stoppedWorktreeIds = (
      await mapWithConcurrency(
        missingIds,
        MISSING_WORKTREE_TEARDOWN_CONCURRENCY,
        async (worktreeId) => {
          try {
            await deps.runtime.stopTerminalsForWorktree(worktreeId, hostFence(repo, worktreeId))
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
            ...hostFence(repo, worktreeId),
            localProvider: provider,
            onPtyStopped: deps.onPtyStopped,
            // Cached pre-shutdown inventory can support only best-effort teardown.
            requirePhysicalStop: false
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
