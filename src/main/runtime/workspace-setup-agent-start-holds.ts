import { waitForInFlightWorktreeCreate } from '../worktree-create-in-flight'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { prepareRuntimeLocalWorktreeSetup } from './runtime-local-worktree-setup'
// A chat created with a workspace whose project waits for setup starts its agent once setup ends.
//
// The hold is the setup completion observation itself, kept only in memory and bounded by the same
// timeout the launch's own wait had: setup that fails, hangs or outlives the host never strands a
// start, it only stops delaying it.

const SETUP_WAIT_TIMEOUT_MS = 60_000

/** Waits for setup to end; settles either way, and stops when `signal` aborts. */
export type WorkspaceSetupCompletion = (signal: AbortSignal) => Promise<unknown>

export class WorkspaceSetupAgentStartHolds {
  private readonly held = new Map<
    string,
    { released: Promise<void>; complete: (completion: WorkspaceSetupCompletion | null) => void }
  >()

  /** Holds agent starts in the workspace from now; `release` names what ends the hold, if anything. */
  hold(worktreeId: string): (completion: WorkspaceSetupCompletion | null) => void {
    const ended = new AbortController()
    const timer = setTimeout(
      () => ended.abort(new Error('setup_wait_timeout')),
      SETUP_WAIT_TIMEOUT_MS
    )
    timer.unref?.()
    const released = new Promise<void>((resolve) => {
      ended.signal.addEventListener('abort', () => resolve(), { once: true })
    }).finally(() => {
      clearTimeout(timer)
      if (this.held.get(worktreeId)?.released === released) {
        this.held.delete(worktreeId)
      }
    })
    const complete = (completion: WorkspaceSetupCompletion | null) => {
      if (!completion) {
        ended.abort()
        return
      }
      void completion(ended.signal)
        .catch(() => undefined)
        .then(() => ended.abort())
    }
    this.held.set(worktreeId, { released, complete })
    return complete
  }

  holdPrepared(
    worktreeId: string,
    prepared: Awaited<ReturnType<typeof prepareRuntimeLocalWorktreeSetup>>
  ): void {
    const { setup, inProcessCompletion, waitForSetup } = prepared
    if (waitForSetup && (setup || inProcessCompletion)) {
      this.hold(worktreeId)
      if (inProcessCompletion) {
        this.observe(worktreeId, () => inProcessCompletion)
      }
    }
  }

  observe(worktreeId: string, completion: WorkspaceSetupCompletion | null): void {
    this.held.get(worktreeId)?.complete(completion)
  }

  /** What an agent start in the workspace waits on first; null when nothing holds it. */
  pending(worktreeId: string): Promise<void> | null {
    return this.held.get(worktreeId)?.released ?? null
  }
}

export function pendingWorkspaceSetupAgentStart(
  workspaceId: string,
  readPending: () => Promise<void> | null
): Promise<void> | null {
  const parsed = splitWorktreeIdForFilesystem(workspaceId)
  const preparation = parsed
    ? waitForInFlightWorktreeCreate(parsed.worktreePath, parsed.repoId)
    : null
  return preparation
    ? preparation.then(async () => {
        await readPending()
      })
    : readPending()
}
