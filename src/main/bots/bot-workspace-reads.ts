import type { Repo } from '../../shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host/execution-host'
import { parseWslUncPath } from '../../shared/file-access/wsl-paths'
import { PrioritySemaphore } from '../../shared/concurrency/priority-semaphore'
import {
  createScopedWorktreeReads,
  type ScopedWorktreeReads
} from '../runtime/workspaces/catalog/scoped-worktree-row-resolution'
import {
  LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS,
  localWorktreePathPresence,
  type LocalWorktreePathPresence
} from '../workspaces/catalog/local-worktree-path-presence'

const PASS_PROBES_IN_FLIGHT = 2
// Bot reads' own probe bound: a stalled mount another feature probes never holds them.
const botPathProbes = new PrioritySemaphore(PASS_PROBES_IN_FLIGHT)
const probe = (pathValue: string, signal?: AbortSignal) =>
  localWorktreePathPresence(pathValue, { signal, semaphore: botPathProbes })

/** One pass's path probes, two at a time under one deadline for the pass; a worktree is probed once per pass. */
class PassPathProbes {
  private readonly results = new Map<string, Promise<LocalWorktreePathPresence>>()
  private readonly queued: (() => void)[] = []
  private next = 0
  private inFlight = 0
  private signal: AbortSignal | undefined

  presence(pathValue: string): Promise<LocalWorktreePathPresence> {
    let result = this.results.get(pathValue)
    if (!result) {
      result = this.fresh(pathValue)
      this.results.set(pathValue, result)
    }
    return result
  }

  /** A probe started now, through the pass's queue, whatever the pass already knows of this path. */
  fresh(pathValue: string): Promise<LocalWorktreePathPresence> {
    const result = new Promise<void>((start) => this.queued.push(start))
      .then(() => {
        // A stalled disk ends the rest of the pass as unverifiable, not one timeout per path.
        this.signal ??= AbortSignal.timeout(LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS)
        return probe(pathValue, this.signal)
      })
      .finally(() => {
        this.inFlight--
        this.drain()
      })
    this.drain()
    return result
  }

  private drain(): void {
    while (this.inFlight < PASS_PROBES_IN_FLIGHT && this.next < this.queued.length) {
      this.inFlight++
      this.queued[this.next++]()
    }
  }
}

/** One batch's repo reads and path probes, shared by every workspace it reads. */
export type BotWorkspaceReads = {
  worktrees: ScopedWorktreeReads
  paths: PassPathProbes
}

export function createBotWorkspaceReads(): BotWorkspaceReads {
  return { worktrees: createScopedWorktreeReads(), paths: new PassPathProbes() }
}

/** Whether to read a local workspace: 'present' to read it, 'gone' with proof, else 'unknown'.
 *  Only this machine's own disk proves a deletion, with the repository still there: an SSH host or
 *  a stopped WSL distro is read as before, and an unreadable path or timed-out probe proves nothing. */
export async function localWorktreeState(
  repo: Repo,
  worktreePath: string,
  reads?: BotWorkspaceReads
): Promise<'present' | 'gone' | 'unknown'> {
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID || parseWslUncPath(worktreePath)) {
    return 'present'
  }
  const worktree = await (reads ? reads.paths.presence(worktreePath) : probe(worktreePath))
  if (worktree === 'directory' || worktree === 'other') {
    return 'present'
  }
  if (worktree === 'unknown') {
    return 'unknown'
  }
  // The repository fresh, after the worktree's absence: a drive unplugged meanwhile takes both,
  // which proves nothing.
  const repoPresence = await (reads ? reads.paths.fresh(repo.path) : probe(repo.path))
  return repoPresence === 'directory' || repoPresence === 'other' ? 'gone' : 'unknown'
}
