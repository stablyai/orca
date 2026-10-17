import { getConnectionExecutionHostId } from '../../shared/execution-host'
import {
  parseGitConfigListSnapshot,
  type GitConfigSnapshot
} from '../../shared/git-config-snapshot-runner'
import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import { gitExecFileAsync } from '../git/runner'
import { readLocalGitConfigSignature } from '../github/local-git-config-signature'
import { requireReachableGitRoute } from '../providers/execution-host-provider-dispatch'

const REPO_GIT_CONFIG_SNAPSHOT_TTL_MS = 30_000
const REPO_GIT_CONFIG_SNAPSHOT_MAX_ENTRIES = 512

export type RepoGitConfigOptions = { wslDistro?: string; admissionTier?: GitAdmissionTier }

type RepoGitConfigSnapshotEntry = {
  expiresAt: number
  gitConfigSignature?: string
  snapshot: GitConfigSnapshot
}

const snapshots = new Map<string, RepoGitConfigSnapshotEntry>()
const inFlight: CoalescedProbes<GitConfigSnapshot | null> = new Map()

function snapshotKey(
  repoPath: string,
  connectionId: string | null | undefined,
  options: RepoGitConfigOptions
): string {
  const runtimeKey = connectionId ? `ssh:${connectionId}` : `local:${options.wslDistro ?? 'host'}`
  return `${runtimeKey}\0${repoPath}`
}

function pruneSnapshots(now: number): void {
  for (const [key, entry] of snapshots) {
    if (entry.expiresAt <= now) {
      snapshots.delete(key)
    }
  }
  // Why: workspace/runtime churn can mint unbounded keys inside one TTL window.
  while (snapshots.size > REPO_GIT_CONFIG_SNAPSHOT_MAX_ENTRIES) {
    const oldest = snapshots.keys().next().value
    if (oldest === undefined) {
      break
    }
    snapshots.delete(oldest)
  }
}

/**
 * The repo's git config, read with one `git config --list -z` per repo and runtime and shared by
 * every branch lookup for 30s. Null when the read fails, so callers fall back to defaults instead
 * of caching an empty config; throws when the host's git is unreachable from here.
 */
export async function getRepoGitConfigSnapshot(
  repoPath: string,
  connectionId?: string | null,
  options: RepoGitConfigOptions = {}
): Promise<GitConfigSnapshot | null> {
  const key = snapshotKey(repoPath, connectionId, options)
  const signatureContext = {
    repoPath,
    connectionId: connectionId ?? null,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {})
  }
  const cached = snapshots.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    if (
      !cached.gitConfigSignature ||
      cached.gitConfigSignature === (await readLocalGitConfigSignature(signatureContext))
    ) {
      return cached.snapshot
    }
  }
  snapshots.delete(key)
  // Why: an unreachable host is not "no config" — throwing keeps the lookup unavailable rather
  // than guessing a head that could attach the wrong review.
  requireReachableGitRoute(getConnectionExecutionHostId(connectionId))
  return runCoalescedProbe(inFlight, key, async (ownsKey) => {
    try {
      const signatureBefore = await readLocalGitConfigSignature(signatureContext)
      const { stdout } = await gitExecFileAsync(['config', '--list', '-z'], {
        cwd: repoPath,
        ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
        ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
      })
      const snapshot = parseGitConfigListSnapshot(stdout)
      // Why: config written mid-read may be half-seen; serve it once but don't cache it.
      if (ownsKey() && signatureBefore === (await readLocalGitConfigSignature(signatureContext))) {
        snapshots.set(key, {
          snapshot,
          expiresAt: Date.now() + REPO_GIT_CONFIG_SNAPSHOT_TTL_MS,
          ...(signatureBefore ? { gitConfigSignature: signatureBefore } : {})
        })
        pruneSnapshots(Date.now())
      }
      return snapshot
    } catch {
      return null
    }
  })
}

export function __resetRepoGitConfigSnapshotCacheForTests(): void {
  snapshots.clear()
  inFlight.clear()
}
