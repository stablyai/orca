import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import {
  buildWorkspaceRows,
  type WorkspaceRowsSnapshot
} from '../../../shared/sidebar-list/workspace-rows'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import type { RuntimeStore } from '../runtime-store-contract'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { runtimeVisibleFolderWorkspaces } from '../runtime-visible-catalog'
import type {
  ResolvedWorktreeRepoScans,
  ResolvedWorktreeScanJoin
} from '../workspaces/resolved-worktree-scan-join'
import { WORKTREE_METADATA_DOMAINS } from '../../persistence/loading-store/worktree-identity-metadata'
import { ProducerRevision } from './producer-revision'
import { WorkspaceGitIdentity } from './workspace-git-identity'
import { CachedScan } from './cached-scan'
import type { WorkspaceLifecycleQueue } from '../workspaces/workspace-lifecycle-queue'

// The settings the visibility filter reads: the defaults, and the layouts that classify a checkout.
const VISIBILITY_SETTINGS = [
  'worktreeVisibilityDefaults',
  'workspaceDir',
  'nestWorkspaces',
  'workspaceDirHistory'
] as const

// The settings that change what git lists: the store invalidates the scan cache with no catalog event.
const SCAN_SETTINGS = ['localWindowsRuntimeDefault'] as const

function settingsKey(store: RuntimeStore, keys: readonly (keyof GlobalSettings)[]): string {
  const settings = store.getSettings()
  return JSON.stringify(keys.map((key) => settings[key] ?? null))
}

// A partial test store may have no settings; it then has nothing to change.
function scanSettingsKey(store: RuntimeStore | null): string | null {
  return typeof store?.getSettings === 'function' ? settingsKey(store, SCAN_SETTINGS) : null
}

function visibilitySettingsKey(store: RuntimeStore): string {
  return settingsKey(store, VISIBILITY_SETTINGS)
}

export type WorkspaceRowsSources = {
  store: RuntimeStore | null
  /** Every git repo's scan (cache-aware); the only slow part, never awaited by a publish. */
  scan: () => Promise<ResolvedWorktreeRepoScans>
  /** The fleet listing from cached scans and the store's metadata as it is now. */
  join: (scans: ResolvedWorktreeRepoScans) => ResolvedWorktreeScanJoin
  /** worktree.ps's visibility filters over a listing. */
  visible: (snapshot: ResolvedWorktreeSnapshot) => ResolvedWorktreeSnapshot
  /** Its finished creates and deletes keep their hints until a fresh scan lists them. */
  lifecycle?: Pick<WorkspaceLifecycleQueue, 'setMembership'> | null
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: false }
  ) => () => void
}

type Joined = {
  revision: number
  all: ResolvedWorktree[]
  rows: WorkspaceRowsSnapshot['rows']
  gitRunById: ResolvedWorktreeScanJoin['gitRunById']
  scannedRepoKeys: ResolvedWorktreeScanJoin['scannedRepoKeys']
}

/** Join cached repo scans with current metadata synchronously; refresh scans separately. Catalog/applied-scan/metadata revisions publish, session saves do not. */
export class WorkspaceRowsProducer {
  readonly revision = new ProducerRevision()
  readonly gitIdentity = new WorkspaceGitIdentity()
  // What the last join's visibility filter read; null until a join or settings save.
  private visibilityKey: string | null = null
  private joined: Joined | null = null
  private scanSettingsKey: string | null
  private readonly askedRepoKeys = new Set<string>()
  private readonly scans: CachedScan<ResolvedWorktreeRepoScans>

  constructor(private readonly sources: WorkspaceRowsSources) {
    this.scanSettingsKey = scanSettingsKey(sources.store)
    this.scans = new CachedScan({
      label: 'workspace-rows',
      scan: () => sources.scan(),
      demand: () => this.revision.hasListeners(),
      applied: () => this.applied()
    })
    sources.lifecycle?.setMembership((done) => this.scans.afterFresh(done))
    sources.onClientEvent(
      (event) => {
        if (event.type === 'worktreesChanged' || event.type === 'reposChanged') {
          this.revision.bump()
          this.scans.request()
        }
      },
      { consumesTerminalSideEffects: false }
    )
    // A full save may be a folder workspace or lineage write.
    sources.store?.onStateWritten?.((domains) => {
      const metadata =
        domains === undefined ||
        WORKTREE_METADATA_DOMAINS.some((domain) => domains.includes(domain))
      const settings = domains !== undefined && domains.includes('settings')
      if (metadata || (settings && this.visibilitySettingsChanged())) {
        // Urgent, and no rescan: metadata joins at read, so the write publishes now from the cache.
        this.revision.bump({ urgent: true })
      }
      if (settings && this.scanSettingsChanged()) {
        this.revision.bump()
        this.scans.request()
      }
    })
  }

  // Every settings save reports above, whichever path wrote it and whether or not it notified.
  private visibilitySettingsChanged(): boolean {
    const previous = this.visibilityKey
    this.visibilityKey = this.sources.store ? visibilitySettingsKey(this.sources.store) : null
    return previous !== null && previous !== this.visibilityKey
  }

  private scanSettingsChanged(): boolean {
    const previous = this.scanSettingsKey
    this.scanSettingsKey = scanSettingsKey(this.sources.store)
    return previous !== this.scanSettingsKey
  }

  /** Settles once a scan this producer can serve from has applied. Never rejects. */
  ready(): Promise<void> {
    return this.scans.ready()
  }

  /** Settles once every scan requested so far has applied; for one-shot RPC readers. */
  settled(): Promise<void> {
    return this.scans.settled()
  }

  /** The rows from the cached scan; null before the first scan applies. */
  snapshot(): WorkspaceRowsSnapshot | null {
    const joined = this.join()
    return joined ? { revision: joined.revision, rows: joined.rows } : null
  }

  /** Every resolved workspace (before visibility) from the cached scan; null before the first. */
  resolvedWorktrees(): readonly ResolvedWorktree[] | null {
    return this.join()?.all ?? null
  }

  private join(): Joined | null {
    const { store } = this.sources
    const scans = this.scans.current
    if (!scans) {
      return null
    }
    const revision = this.revision.value
    if (this.joined?.revision === revision) {
      return this.joined
    }
    if (!store) {
      return { revision, all: [], rows: {}, gitRunById: new Map(), scannedRepoKeys: new Set() }
    }
    this.visibilityKey = visibilitySettingsKey(store)
    const listing = this.sources.join(scans)
    // Once per new repo: a repo no scan lists (it failed, or vanished mid-scan) must not loop.
    const unasked = [...listing.unscannedRepoKeys].filter((key) => !this.askedRepoKeys.has(key))
    if (unasked.length > 0) {
      unasked.forEach((key) => this.askedRepoKeys.add(key))
      this.scans.request()
    }
    const all = listing.worktrees.map((worktree) => {
      const displayName = this.gitIdentity.title(worktree)
      return displayName === worktree.displayName ? worktree : { ...worktree, displayName }
    })
    const { worktrees, platformByRepoId } = this.sources.visible({ ...listing, worktrees: all })
    const rows = buildWorkspaceRows({
      worktrees,
      folderWorkspaces: runtimeVisibleFolderWorkspaces(store),
      repos: store.getRepos(),
      lineageById: store.getAllWorktreeLineage?.() ?? {}
    })
    for (const row of rows.values()) {
      const terminalPlatform = row.kind === 'git' ? platformByRepoId.get(row.repoId) : undefined
      if (terminalPlatform) {
        row.terminalPlatform = terminalPlatform
      }
    }
    this.joined = {
      revision,
      all,
      rows: Object.fromEntries(rows),
      gitRunById: listing.gitRunById,
      scannedRepoKeys: listing.scannedRepoKeys
    }
    return this.joined
  }

  private applied(): void {
    this.joined = null
    const listing = this.join()
    const { store } = this.sources
    if (listing && store) {
      const scanned = listing.all.flatMap((worktree) => {
        const gitRun = listing.gitRunById.get(
          composeWorktreeHostIdentity(worktree.hostId, worktree.id)
        )
        return gitRun === undefined ? [] : [{ ...worktree, gitRun }]
      })
      const clears = this.gitIdentity.observeScan(scanned, listing.scannedRepoKeys)
      for (const { target, updates } of clears) {
        store.setWorktreeMeta(target, updates)
      }
    }
    this.revision.bump()
  }
}
