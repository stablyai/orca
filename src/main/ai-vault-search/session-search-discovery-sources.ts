import type { SessionSearchRemovalReceipt } from './session-search-observation-authority'
import type { SessionSearchCandidateInput } from './session-search-catalog-candidate-types'
import {
  SessionSearchCatalogClient,
  recordSessionSearchCatalogCounts,
  type SessionSearchCatalogRequest
} from './session-search-catalog-client'
import type { SessionSearchDependencyInventory } from './session-search-dependency-inventory'
import { SessionSearchRootWatchers } from './session-search-root-watchers'
import { SessionSearchContainerInventory } from './session-search-container-inventory'
import type { SessionFileInventory } from '../ai-vault/session-file-inventory'
import type { DiscoverSessionFilesArgs } from '../ai-vault/session-scanner-discovery'
import type { SessionFileCandidate, SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import {
  sessionSearchPhysicalRoot,
  type SessionSearchScanRoots
} from './discovery/session-search-scan-roots'

type Root = {
  inventory: SessionFileInventory
  args: DiscoverSessionFilesArgs
  identity?: string
  fallback: boolean
  unwatched?: boolean
  wake?: number
  retiring?: boolean
  dependencies: Map<string, SessionSearchDependencyInventory>
}

/** Search owns its notifications and raw membership; ordinary History discovery stays stateless. */
export class SessionSearchDiscoverySources {
  private readonly active = new Set<Promise<unknown>>()
  protected track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work)
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work)
    )
    return work
  }
  async settled(): Promise<void> {
    while (this.active.size) {
      await Promise.allSettled(this.active)
    }
  }
  protected readonly roots = new Map<string, Root>()
  readonly containers = new SessionSearchContainerInventory()
  protected readonly owner = new AbortController()
  protected readonly watchers: SessionSearchRootWatchers
  protected request: SessionSearchCatalogRequest | undefined
  protected metadataDebt: SessionSearchCatalogClient<number> | undefined
  protected acceptRemoved:
    | ((
        paths: readonly string[],
        observations?: ReadonlyMap<string, SessionSearchRemovalReceipt>
      ) => Promise<void>)
    | undefined
  onRemoved(accept: NonNullable<SessionSearchDiscoverySources['acceptRemoved']>): void {
    this.acceptRemoved = accept
  }
  protected admitSeed: ((root: string, agent: string) => Promise<boolean>) | undefined
  onSeedAdmission(accept: NonNullable<SessionSearchDiscoverySources['admitSeed']>): void {
    this.admitSeed = accept
  }
  protected accept:
    | ((
        discovery: SessionFileDiscovery,
        forced?: ReadonlySet<string>,
        metadata?: ReadonlySet<string>,
        inputs?: ReadonlyMap<string, SessionSearchCandidateInput>
      ) => Promise<boolean | void>)
    | undefined
  onDiscovery(accept: NonNullable<SessionSearchDiscoverySources['accept']>): void {
    this.accept = accept
  }
  protected discoveryInput(
    root: Root,
    path: string,
    revision: number,
    metadataValue: number | undefined
  ): SessionSearchCandidateInput {
    return {
      scope: root.inventory.scope,
      revision,
      metadataValue: metadataValue === undefined ? undefined : JSON.stringify(metadataValue),
      dependencyOwners: [...root.dependencies.values()].flatMap((observer) => {
        const owner = observer.fileOwner(path)
        return owner ? [owner] : []
      })
    }
  }
  protected async settleDependencies(root: Root): Promise<void> {
    for (const observer of root.dependencies.values()) {
      await observer.settleDelivered(root.inventory.scope, this.overdue)
      if (!root.inventory.pending && !root.inventory.refused) {
        await observer.discardUnowned(this.overdue)
      }
    }
  }
  attach(request: SessionSearchCatalogRequest): void {
    this.request ??= request
    this.metadataDebt ??= new SessionSearchCatalogClient('discovery-metadata', request)
    this.containers.attach(request)
  }
  protected force = false
  protected maintenance = false
  protected primaryWake: number | undefined
  protected overdue = () => false
  protected recentLimit = 12
  protected seen = new Set<string>()
  readonly removed = new Set<string>()
  readonly enumeratedContainers = this.containers.proofs

  constructor(entryPath?: string) {
    this.watchers = new SessionSearchRootWatchers(entryPath)
  }

  begin(options: {
    full: boolean
    primaryWake?: number
    maintenance?: boolean
    overdue: () => boolean
    recentLimit: number
  }): void {
    this.force = options.full
    this.primaryWake = options.primaryWake
    this.maintenance = options.maintenance === true
    this.overdue = options.overdue
    this.recentLimit = options.recentLimit
    this.watchers.begin()
    this.seen = new Set()
    this.containers.begin(options.full || this.maintenance, this.recentLimit)
    this.removed.clear()
  }

  get walking(): boolean {
    return [...this.roots.values()].some((root) => root.inventory.walking)
  }

  get pending(): boolean {
    if (this.containers.pending || this.watchers.pending) {
      return true
    }
    for (const root of this.roots.values()) {
      if (
        root.retiring ||
        root.inventory.pending ||
        [...root.dependencies.values()].some((dependency) => dependency.pending)
      ) {
        return true
      }
    }
    return false
  }

  listings(): { root: string; files: number; absent: boolean }[] {
    return [...this.roots.values()].map((root) => ({
      root: root.inventory.root,
      files: root.inventory.fileCount,
      absent: this.watchers.isMissing(root.inventory.root) && root.inventory.empty
    }))
  }

  private fileOwner(candidate: SessionFileCandidate, root: string, roots: SessionSearchScanRoots) {
    const {
      agent,
      file: { path }
    } = candidate
    const rootDir = sessionSearchPhysicalRoot(roots, { agent, rootDir: root }, path)
    if (rootDir === null) {
      return null
    }
    const owner = rootDir === undefined ? undefined : this.roots.get(`${agent}:${rootDir}`)
    if (!owner) {
      throw new Error('Session search read has no physical inventory owner')
    }
    return owner
  }

  async hasPublicationDebt(
    candidate: SessionFileCandidate,
    logicalRoot: string,
    roots: SessionSearchScanRoots
  ): Promise<boolean> {
    return (
      this.fileOwner(candidate, logicalRoot, roots)?.inventory.hasPublicationDebt(
        candidate.file.path
      ) ?? false
    )
  }

  async observeForRead(
    candidate: SessionFileCandidate,
    logicalRoot: string,
    roots: SessionSearchScanRoots,
    metadataOnly = false,
    metadataOwed = false
  ) {
    const root = this.fileOwner(candidate, logicalRoot, roots)
    if (!root) {
      return null
    }
    const path = candidate.file.path
    const change = await root.inventory.observeForRead(
      path,
      root.args,
      this.recentLimit,
      metadataOnly,
      metadataOwed,
      [...root.dependencies.values()].flatMap((observer) => {
        const owner = observer.fileOwner(path)
        return owner ? [owner] : []
      })
    )
    if (change.file === undefined) {
      return change
    }
    return {
      ...change,
      changed:
        change.changed ||
        change.file.mtimeMs !== candidate.file.mtimeMs ||
        change.file.sizeBytes !== candidate.file.sizeBytes ||
        change.file.dev !== candidate.file.dev ||
        change.file.ino !== candidate.file.ino
    }
  }

  acceptReadCounts(scopeCounts: [string, number, number][] | undefined): void {
    if (this.request) {
      recordSessionSearchCatalogCounts(this.request, { scopeCounts })
    }
  }

  async end(): Promise<void> {
    await this.watchers.end()
    await this.containers.end()
    for (const key of this.roots.keys()) {
      if (!this.seen.has(key)) {
        const root = this.roots.get(key)!
        root.retiring = true
        do {
          const paths = await root.inventory.removePage()
          if (this.acceptRemoved) {
            await this.acceptRemoved(paths)
          } else {
            for (const path of paths) {
              this.removed.add(path)
            }
          }
          await root.inventory.retirePage(paths)
          if (paths.length) {
            continue
          }
          if (!(await root.inventory.releasePage())) {
            continue
          }
          let released = true
          for (const dependency of root.dependencies.values()) {
            released = (await dependency.release()) && released
          }
          if (released) {
            this.roots.delete(key)
            break
          }
        } while (!this.overdue() && !this.owner.signal.aborted)
      }
    }
  }

  close(): Promise<void> {
    this.owner.abort()
    this.roots.clear()
    this.containers.clear()
    return this.watchers.close()
  }
}
