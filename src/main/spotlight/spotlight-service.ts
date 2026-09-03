import type { BrowserWindow } from 'electron'
import type {
  SpotlightError,
  SpotlightOpResult,
  SpotlightRepoState,
  SpotlightStateSnapshot
} from '../../shared/spotlight'
import {
  activateSpotlightCore,
  deactivateSpotlightCore,
  inspectSpotlightRefsCore,
  purgeSpotlightRefsCore,
  syncSpotlightCore
} from '../../shared/spotlight-sync-core'
import { appendSpotlightLogNote, stopSpotlightLogCapture } from './spotlight-log-mirror'
import { writeSpotlightStateFile } from './spotlight-state-file'
import {
  activeStateFromActivation,
  isRootHolderPath,
  pendingSpotlightState,
  resolveRepoContext,
  syncedSpotlightState,
  toSpotlightError,
  worktreePathFromId,
  type ResolvedRepoContext
} from './spotlight-service-state'
import { getWorktreePathBasenameFromId } from '../../shared/worktree/id'
import type { Store } from '../persistence'

export class SpotlightService {
  private readonly store: Store
  private readonly getMainWindow: () => BrowserWindow | null
  // Why: activate/sync/deactivate mutate the same repo root; a per-repo
  // promise chain serializes them so watcher-driven syncs can't interleave
  // with an in-flight takeover or deactivation.
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Last worktree+HEAD each repo's temp index was seeded from, to skip a rescan
   *  on the next checkpoint. Records the worktree so a takeover doesn't reuse a
   *  different worktree's index (a miss just costs one rescan). */
  private readonly lastCheckpointByRepo = new Map<string, { worktreeId: string; headSha: string }>()

  /** The HEAD to pass as reuseIndexForHead, only when the last checkpoint was
   *  for THIS worktree (so its temp index exists and is HEAD-seeded). */
  private reuseIndexHeadFor(repoId: string, worktreeId: string): string | null {
    const last = this.lastCheckpointByRepo.get(repoId)
    return last && last.worktreeId === worktreeId ? last.headSha : null
  }

  constructor(store: Store, getMainWindow: () => BrowserWindow | null) {
    this.store = store
    this.getMainWindow = getMainWindow
  }

  /** Current persisted state for a repo, or null when Spotlight is off. */
  getState(repoId: string): SpotlightRepoState | null {
    return this.store.getSpotlightState(repoId)
  }

  getStateSnapshot(): SpotlightStateSnapshot {
    const byRepo: Record<string, SpotlightRepoState> = {}
    for (const [repoId, state] of Object.entries(this.store.getAllSpotlightStates())) {
      byRepo[repoId] = state
    }
    return { byRepo }
  }

  async activate(repoId: string, worktreeId: string): Promise<SpotlightOpResult> {
    return this.withRepoLock(repoId, async () => {
      const resolved = this.resolveRepoContext(repoId)
      if ('error' in resolved) {
        return this.failure(repoId, resolved.error)
      }
      const worktreePath = worktreePathFromId(repoId, worktreeId)
      if (!worktreePath) {
        return this.failure(repoId, {
          code: 'worktree-not-found',
          message: `Unknown worktree id: ${worktreeId}`
        })
      }
      if (isRootHolderPath(worktreePath, resolved.repo.path)) {
        return this.failure(repoId, {
          code: 'root-is-holder',
          message: 'The primary worktree cannot hold the Spotlight — it is the sync target.'
        })
      }

      const previous = this.store.getSpotlightState(repoId)
      // Only gate a FRESH activation: it must start on a real branch (not
      // detached) so deactivate can re-attach cleanly. Takeover is exempt (the
      // root is legitimately detached-by-Spotlight then).
      const requireOnBranch = !previous
      this.emitSyncing(repoId, {
        ...(previous ?? pendingSpotlightState(repoId, worktreeId, Date.now())),
        holderWorktreeId: worktreeId
      })
      try {
        const outcome = await activateSpotlightCore(
          resolved.ctx,
          resolved.repo.path,
          worktreePath,
          {
            reuseIndexForHead: this.reuseIndexHeadFor(repoId, worktreeId),
            requireOnBranch
          }
        )
        this.lastCheckpointByRepo.set(repoId, {
          worktreeId,
          headSha: outcome.checkpointHeadSha
        })
        const state = activeStateFromActivation(repoId, worktreeId, outcome, previous?.activatedAt)
        this.store.setSpotlightState(repoId, state)
        this.emitChanged(repoId, state)
        void writeSpotlightStateFile(resolved.repo.path, state)
        if (previous?.holderWorktreeId !== worktreeId) {
          // Header for agents tailing the log: everything after this line is
          // the output of THIS workspace's code mirrored onto the root.
          const holderName = getWorktreePathBasenameFromId(worktreeId) ?? worktreeId
          void appendSpotlightLogNote(
            resolved.repo.path,
            `Spotlight → workspace "${holderName}" now mirrors to the root`
          )
        }
        return { ok: true, state }
      } catch (error) {
        return this.failure(repoId, toSpotlightError(error), previous)
      }
    })
  }

  async sync(repoId: string, opts: { force?: boolean } = {}): Promise<SpotlightOpResult> {
    return this.withRepoLock(repoId, async () => {
      const state = this.store.getSpotlightState(repoId)
      if (!state) {
        return this.failure(repoId, {
          code: 'not-active',
          message: 'Spotlight is not active for this repository.'
        })
      }
      const resolved = this.resolveRepoContext(repoId)
      if ('error' in resolved) {
        return this.failure(repoId, resolved.error, state)
      }
      const worktreePath = worktreePathFromId(repoId, state.holderWorktreeId)
      if (!worktreePath) {
        return this.failure(repoId, {
          code: 'worktree-not-found',
          message: `Unknown worktree id: ${state.holderWorktreeId}`
        })
      }

      // Why NO optimistic emitSyncing here (unlike activate): the watcher fires
      // this every ~300ms and most calls are no-ops, so a 'syncing'→'active'
      // broadcast per call would flash the spinner and re-render every
      // subscriber (and invalidate the editor watch-target cache) on idle syncs.
      try {
        const outcome = await syncSpotlightCore(resolved.ctx, resolved.repo.path, worktreePath, {
          force: opts.force,
          reuseIndexForHead: this.reuseIndexHeadFor(repoId, state.holderWorktreeId)
        })
        this.lastCheckpointByRepo.set(repoId, {
          worktreeId: state.holderWorktreeId,
          headSha: outcome.checkpointHeadSha
        })
        // Nothing was mirrored and the snapshot is unchanged. Skip the store
        // write + broadcast entirely UNLESS a prior error needs clearing, so an
        // idle sync burst doesn't churn state that is byte-for-byte identical.
        if (outcome.skipped && !state.lastError) {
          return { ok: true, state }
        }
        const next = syncedSpotlightState(state, outcome)
        this.store.setSpotlightState(repoId, next)
        this.emitChanged(repoId, next)
        void writeSpotlightStateFile(resolved.repo.path, next)
        return { ok: true, state: next }
      } catch (error) {
        return this.failure(repoId, toSpotlightError(error), state)
      }
    })
  }

  async deactivate(
    repoId: string,
    opts: { discardBackup?: boolean } = {}
  ): Promise<SpotlightOpResult> {
    return this.withRepoLock(repoId, async () => {
      const state = this.store.getSpotlightState(repoId)
      // requireEnabled:false — turning the repo's Spotlight toggle off while it
      // is active must not lock the user out of restoring the root.
      const resolved = this.resolveRepoContext(repoId, { requireEnabled: false })
      if ('error' in resolved) {
        return this.failure(repoId, resolved.error, state)
      }
      if (state) {
        this.emitSyncing(repoId, state)
      }
      try {
        const outcome = await deactivateSpotlightCore(resolved.ctx, resolved.repo.path, {
          discardBackup: opts.discardBackup
        })
        this.clearSpotlightRecord(repoId, resolved.repo.path)
        void appendSpotlightLogNote(
          resolved.repo.path,
          outcome.branchMissing
            ? `Spotlight off — root restored but left detached (branch "${
                outcome.originalBranch ?? '?'
              }" was unavailable)`
            : 'Spotlight off — the root shows its own code again'
        )
        return outcome.branchMissing
          ? {
              ok: true,
              state: null,
              // Name only when the branch still exists but is in use elsewhere
              // (recoverable by freeing it); null when it was deleted, so the
              // renderer shows the correct "no longer exists" message.
              leftDetachedFromBranch: outcome.branchInUse ? outcome.originalBranch : null
            }
          : { ok: true, state: null }
      } catch (error) {
        const spotlightError = toSpotlightError(error)
        if (spotlightError.code === 'not-active') {
          // The refs are already gone (manual cleanup); drop the stale record.
          this.clearSpotlightRecord(repoId, resolved.repo.path)
          return { ok: true, state: null }
        }
        return this.failure(repoId, spotlightError, state)
      }
    })
  }

  /** Reconcile persisted state against the git refs (source of truth) for
   *  every repo with a persisted Spotlight record. Safe to re-run. */
  async reconcileAll(): Promise<void> {
    for (const repoId of Object.keys(this.store.getAllSpotlightStates())) {
      await this.reconcile(repoId)
    }
  }

  async reconcile(repoId: string): Promise<void> {
    await this.withRepoLock(repoId, async () => {
      const state = this.store.getSpotlightState(repoId)
      if (!state) {
        return
      }
      const resolved = this.resolveRepoContext(repoId)
      if ('error' in resolved) {
        return
      }
      try {
        const refs = await inspectSpotlightRefsCore(resolved.ctx, resolved.repo.path)
        if (!refs.originalHeadSha || !refs.snapshotSha) {
          // gitTry returns null on read failure too, not only for missing refs.
          // A null rootHeadSha means the read itself failed, so keep the record
          // and retry later rather than tear down a still-active Spotlight.
          if (!refs.rootHeadSha) {
            return
          }
          // Refs were removed outside Orca — the repo is no longer in Spotlight
          // mode, so the persisted record is stale.
          this.clearSpotlightRecord(repoId, resolved.repo.path)
          return
        }
        if (refs.rootHeadSha !== refs.snapshotSha) {
          const next: SpotlightRepoState = {
            ...state,
            lastError: {
              code: 'root-diverged',
              message: 'The repository root moved off the Spotlight snapshot while Orca was closed.'
            }
          }
          this.store.setSpotlightState(repoId, next)
          this.emitChanged(repoId, next)
          void writeSpotlightStateFile(resolved.repo.path, next)
        }
      } catch {
        // Repo unreadable right now (e.g. missing disk); keep the record and
        // let the next reconcile or user action sort it out.
      }
    })
  }

  private resolveRepoContext(
    repoId: string,
    opts: { requireEnabled?: boolean } = {}
  ): ResolvedRepoContext {
    return resolveRepoContext(this.store, repoId, opts)
  }

  /** Tear down all Spotlight resources for a repo once its refs are gone/restored.
   *  Main owns the lifecycle (not the PTY), so it also stops the log capture. */
  private clearSpotlightRecord(repoId: string, rootPath: string | null): void {
    stopSpotlightLogCapture({ repoId })
    this.lastCheckpointByRepo.delete(repoId)
    this.store.clearSpotlightState(repoId)
    this.emitChanged(repoId, null)
    if (rootPath) {
      void writeSpotlightStateFile(rootPath, null)
    }
  }

  /** Force-clean Spotlight refs + the persisted record when a repo is being
   *  removed and a normal deactivate couldn't finish. Preserves the backup ref. */
  async purgeForTeardown(repoId: string): Promise<void> {
    await this.withRepoLock(repoId, async () => {
      const resolved = this.resolveRepoContext(repoId, { requireEnabled: false })
      if ('error' in resolved) {
        this.clearSpotlightRecord(repoId, null)
        return
      }
      await purgeSpotlightRefsCore(resolved.ctx, resolved.repo.path)
      this.clearSpotlightRecord(repoId, resolved.repo.path)
    })
  }

  private failure(
    repoId: string,
    error: SpotlightError,
    previous?: SpotlightRepoState | null
  ): SpotlightOpResult {
    const state = previous ? { ...previous, status: 'active' as const, lastError: error } : null
    if (state) {
      this.store.setSpotlightState(repoId, state)
      // Keep the agent-facing state file in step with the failure: without this
      // a live sync failure (e.g. root-diverged) leaves the file claiming the
      // last successful sync's active/clean state, so an agent misattributes
      // stale server-log errors to its own changes.
      const repo = this.store.getRepo(repoId)
      if (repo) {
        void writeSpotlightStateFile(repo.path, state)
      }
    }
    this.emitChanged(repoId, state)
    return { ok: false, error, state }
  }

  private emitSyncing(repoId: string, state: SpotlightRepoState): void {
    this.send(repoId, { ...state, status: 'syncing' })
  }

  private emitChanged(repoId: string, state: SpotlightRepoState | null): void {
    this.send(repoId, state)
  }

  private send(repoId: string, state: SpotlightRepoState | null): void {
    const window = this.getMainWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send('spotlight:changed', { repoId, state })
    }
  }

  private withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(repoId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    this.locks.set(
      repoId,
      next.catch(() => {})
    )
    return next
  }
}
