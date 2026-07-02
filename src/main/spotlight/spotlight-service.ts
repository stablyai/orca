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
  syncSpotlightCore
} from '../../shared/spotlight-sync-core'
import { appendSpotlightLogNote, stopSpotlightLogCapture } from './spotlight-log-mirror'
import { writeSpotlightStateFile } from './spotlight-state-file'
import {
  pendingSpotlightState,
  resolveRepoContext,
  toSpotlightError,
  worktreePathFromId,
  type ResolvedRepoContext
} from './spotlight-service-state'
import { getWorktreePathBasenameFromId } from '../../shared/worktree-id'
import type { Store } from '../persistence'

export class SpotlightService {
  private readonly store: Store
  private readonly getMainWindow: () => BrowserWindow | null
  // Why: activate/sync/deactivate mutate the same repo root; a per-repo
  // promise chain serializes them so watcher-driven syncs can't interleave
  // with an in-flight takeover or deactivation.
  private readonly locks = new Map<string, Promise<unknown>>()
  /** In-memory status overlay: persisted state never stores 'syncing'. */
  private readonly syncingRepoIds = new Set<string>()
  /** Worktree HEAD each repo's last checkpoint was built on, so the next
   *  checkpoint can reuse the temp index (skip a full-worktree rescan) when
   *  HEAD hasn't moved. In-memory only — a miss just costs one extra rescan. */
  private readonly lastCheckpointHeadByRepo = new Map<string, string>()

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
      byRepo[repoId] = this.withLiveStatus(repoId, state)
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
      if (worktreePath === resolved.repo.path) {
        return this.failure(repoId, {
          code: 'root-is-holder',
          message: 'The primary worktree cannot hold the Spotlight — it is the sync target.'
        })
      }

      const previous = this.store.getSpotlightState(repoId)
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
            reuseIndexForHead: this.lastCheckpointHeadByRepo.get(repoId) ?? null
          }
        )
        this.lastCheckpointHeadByRepo.set(repoId, outcome.checkpointHeadSha)
        const state: SpotlightRepoState = {
          repoId,
          holderWorktreeId: worktreeId,
          status: 'active',
          originalBranch: outcome.originalBranch,
          originalHeadSha: outcome.originalHeadSha,
          backupSha: outcome.backupSha,
          lastSnapshotSha: outcome.snapshotSha,
          activatedAt: previous?.activatedAt ?? Date.now(),
          lastSyncAt: Date.now(),
          lastError: null
        }
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

      this.emitSyncing(repoId, state)
      try {
        const outcome = await syncSpotlightCore(resolved.ctx, resolved.repo.path, worktreePath, {
          force: opts.force,
          reuseIndexForHead: this.lastCheckpointHeadByRepo.get(repoId) ?? null
        })
        this.lastCheckpointHeadByRepo.set(repoId, outcome.checkpointHeadSha)
        const next: SpotlightRepoState = {
          ...state,
          status: 'active',
          lastSnapshotSha: outcome.snapshotSha,
          lastSyncAt: outcome.skipped ? state.lastSyncAt : Date.now(),
          lastError: null
        }
        this.store.setSpotlightState(repoId, next)
        this.emitChanged(repoId, next)
        if (!outcome.skipped) {
          void writeSpotlightStateFile(resolved.repo.path, next)
        }
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
      const resolved = this.resolveRepoContext(repoId)
      if ('error' in resolved) {
        return this.failure(repoId, resolved.error, state)
      }
      if (state) {
        this.emitSyncing(repoId, state)
      }
      try {
        await deactivateSpotlightCore(resolved.ctx, resolved.repo.path, {
          discardBackup: opts.discardBackup
        })
        // Why here (not the renderer): log capture + the restart-trigger watcher
        // are tied to the Spotlight LIFECYCLE, which main owns. Stopping them on
        // PTY death alone left a turned-off Spotlight still mirroring the
        // terminal and honoring restart triggers.
        stopSpotlightLogCapture({ repoId })
        this.lastCheckpointHeadByRepo.delete(repoId)
        this.store.clearSpotlightState(repoId)
        this.emitChanged(repoId, null)
        void writeSpotlightStateFile(resolved.repo.path, null)
        void appendSpotlightLogNote(
          resolved.repo.path,
          'Spotlight off — the root shows its own code again'
        )
        return { ok: true, state: null }
      } catch (error) {
        const spotlightError = toSpotlightError(error)
        if (spotlightError.code === 'not-active') {
          // The refs are already gone (manual cleanup); drop the stale record.
          stopSpotlightLogCapture({ repoId })
          this.lastCheckpointHeadByRepo.delete(repoId)
          this.store.clearSpotlightState(repoId)
          this.emitChanged(repoId, null)
          void writeSpotlightStateFile(resolved.repo.path, null)
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
          // Refs were removed outside Orca — the repo is no longer in
          // Spotlight mode, so the persisted record is stale.
          this.store.clearSpotlightState(repoId)
          this.emitChanged(repoId, null)
          // Why: keep the agent-facing state file from claiming active:true
          // forever after the refs vanish (agents read it before trusting logs).
          void writeSpotlightStateFile(resolved.repo.path, null)
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

  private resolveRepoContext(repoId: string): ResolvedRepoContext {
    return resolveRepoContext(this.store, repoId)
  }

  private withLiveStatus(repoId: string, state: SpotlightRepoState): SpotlightRepoState {
    return this.syncingRepoIds.has(repoId) ? { ...state, status: 'syncing' } : state
  }

  private failure(
    repoId: string,
    error: SpotlightError,
    previous?: SpotlightRepoState | null
  ): SpotlightOpResult {
    const state = previous ? { ...previous, status: 'active' as const, lastError: error } : null
    if (state) {
      this.store.setSpotlightState(repoId, state)
    }
    this.emitChanged(repoId, state)
    return { ok: false, error, state }
  }

  private emitSyncing(repoId: string, state: SpotlightRepoState): void {
    this.syncingRepoIds.add(repoId)
    this.send(repoId, { ...state, status: 'syncing' })
  }

  private emitChanged(repoId: string, state: SpotlightRepoState | null): void {
    this.syncingRepoIds.delete(repoId)
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
