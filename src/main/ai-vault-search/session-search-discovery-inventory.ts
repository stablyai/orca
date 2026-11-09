import { SessionSearchRootWatchers } from './session-search-root-watchers'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { SessionFileInventory } from '../ai-vault/session-file-inventory'
import {
  discoverSessionFiles,
  isMissingTranscriptPathError,
  type DiscoverSessionFilesArgs
} from '../ai-vault/session-scanner-discovery'
import type { SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import type { SessionDiscoveryContext } from '../ai-vault/session-discovery-context'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import { splitSyntheticSessionSource } from './session-search-synthetic-sources'

type Root = {
  inventory: SessionFileInventory
  args: DiscoverSessionFilesArgs
  identity?: string
  fallback: boolean
  fallbackCount?: number
  dependencyKeys: Map<string, Map<string, Set<string>>>
  dependencySnapshots: Map<string, ReadonlyMap<string, string>>
}
type Container = { signature: string; discovery: SessionFileDiscovery; membership: Set<string> }

/** Search owns its notifications and raw membership; ordinary History discovery stays stateless. */
export class SessionSearchDiscoveryInventory implements SessionDiscoveryContext {
  private readonly roots = new Map<string, Root>()
  private readonly artifactMaps = new Map<string, Map<string, string>>()
  private readonly containers = new Map<string, Container>()
  private readonly owner = new AbortController()
  private readonly watchers: SessionSearchRootWatchers
  private force = false
  private overdue = () => false
  private recentLimit = 12
  private seen = new Set<string>()
  readonly forced = new Set<string>()
  readonly metadata = new Set<string>()
  readonly removed = new Set<string>()
  readonly enumeratedContainers = new Map<string, ReadonlySet<string>>()

  constructor(entryPath?: string) {
    this.watchers = new SessionSearchRootWatchers(entryPath)
  }

  begin(options: { full: boolean; overdue: () => boolean; recentLimit: number }): void {
    this.force = options.full
    this.overdue = options.overdue
    this.recentLimit = options.recentLimit
    this.watchers.begin()
    this.seen = new Set()
    this.forced.clear()
    this.metadata.clear()
    this.removed.clear()
    this.enumeratedContainers.clear()
  }

  get pending(): boolean {
    for (const root of this.roots.values()) {
      if (!root.fallback && root.inventory.pending) {
        return true
      }
    }
    return false
  }

  listings(): { root: string; files: number }[] {
    return [...this.roots.values()].map((root) => ({
      root: root.inventory.root,
      files: root.fallback ? (root.fallbackCount ?? 0) : root.inventory.files.size
    }))
  }

  artifacts(root: string): Map<string, string> {
    let map = this.artifactMaps.get(root)
    if (!map) {
      map = new Map()
      this.artifactMaps.set(root, map)
    }
    return map
  }

  membership(key: string): ReadonlySet<string> | undefined {
    return this.containers.get(key)?.membership
  }

  async files(args: DiscoverSessionFilesArgs): Promise<SessionFileDiscovery> {
    const key = `${args.agent}:${args.rootDir}`
    this.seen.add(key)
    let root = this.roots.get(key)
    if (!root) {
      const fallback = await this.watchers.requiresPolling(args.rootDir)
      root = {
        inventory: new SessionFileInventory(args.rootDir),
        args,
        fallback,
        dependencyKeys: new Map(),
        dependencySnapshots: new Map()
      }
      this.roots.set(key, root)
    }
    root.args = args
    if (root.fallback) {
      const discovery = await discoverSessionFiles(args)
      root.fallbackCount = discovery.files.length
      return discovery
    }
    const watch = await this.watchers.watch(args.rootDir, args.signal)
    if (!watch) {
      // Missing roots remain obligations; never replace their retained membership with an empty delta.
      root.inventory.reconcile()
    } else {
      if (this.force || watch.reconcile || root.identity !== watch.identity) {
        root.inventory.reconcile()
      }
      if (root.identity !== watch.identity && (await this.watchers.requiresPolling(args.rootDir))) {
        root.fallback = true
        const discovery = await discoverSessionFiles(args)
        root.fallbackCount = discovery.files.length
        return discovery
      }
      root.identity = watch.identity
      for (const event of watch.events.values()) {
        root.inventory.invalidate(event.path)
      }
    }
    const auxiliaries = await Promise.all(
      (args.searchDependencies ?? []).map(async (dependency) => ({
        dependency,
        watch: await this.watchers.watch(dependency.path, args.signal)
      }))
    )
    for (const { dependency, watch: auxiliary } of auxiliaries) {
      let keys = root.dependencyKeys.get(dependency.path)
      if (!keys) {
        keys = new Map()
        root.dependencyKeys.set(dependency.path, keys)
      }
      if (!auxiliary) {
        continue
      }
      if (auxiliary.reconcile || auxiliary.failed) {
        for (const file of root.inventory.files.values()) {
          root.inventory.invalidate(file.path)
          if (dependency.metadata) {
            this.metadata.add(file.path)
          }
        }
      }
      const eventKeys = new Set<string>()
      for (const event of auxiliary.events.values()) {
        for (const path of root.inventory.dependencies.get(event.path) ?? []) {
          root.inventory.invalidate(path)
          if (dependency.metadata) {
            this.metadata.add(path)
          }
        }
        const key = dependency.eventKey?.(event.path)
        if (key) {
          eventKeys.add(key)
        }
      }
      if (dependency.snapshot && (auxiliary.reconcile || eventKeys.size)) {
        const snapshot = await dependency.snapshot()
        const previous = root.dependencySnapshots.get(dependency.path)
        root.dependencySnapshots.set(dependency.path, snapshot)
        eventKeys.clear()
        for (const [key, value] of snapshot) {
          if (previous?.get(key) !== value) {
            eventKeys.add(key)
          }
        }
        for (const key of previous?.keys() ?? []) {
          if (!snapshot.has(key)) {
            eventKeys.add(key)
          }
        }
        // Nonstandard filenames cannot identify their thread until parsed.
        eventKeys.add('*')
      }
      for (const key of eventKeys) {
        for (const path of keys.get(key) ?? []) {
          root.inventory.invalidate(path)
          if (dependency.metadata) {
            this.metadata.add(path)
          }
        }
      }
    }
    root.inventory.retryFailures()
    await root.inventory.pollRecent(args, this.recentLimit)
    const delta = await root.inventory.drain(args, this.overdue, this.recentLimit)
    for (const change of delta.changes) {
      if (change.force) {
        this.forced.add(change.file.path)
      }
      for (const { dependency } of auxiliaries) {
        const key = dependency.fileKey?.(change.file.path)
        if (!key) {
          continue
        }
        const keys = root.dependencyKeys.get(dependency.path)!
        const paths = keys.get(key) ?? new Set<string>()
        paths.add(change.file.path)
        keys.set(key, paths)
      }
    }
    for (const path of delta.removed) {
      for (const dependency of args.searchDependencies ?? []) {
        const key = dependency.fileKey?.(path)
        if (key) {
          const keys = root.dependencyKeys.get(dependency.path)
          const paths = keys?.get(key)
          paths?.delete(path)
          if (!paths?.size) {
            keys?.delete(key)
          }
        }
      }
      this.removed.add(path)
    }
    return {
      agent: args.agent,
      rootDir: args.rootDir,
      files: delta.changes.map((change) => change.file)
    }
  }

  async container(
    key: string,
    paths: readonly string[],
    read: () => Promise<SessionFileDiscovery>
  ): Promise<SessionFileDiscovery> {
    const signature = (
      await Promise.all(
        paths
          .flatMap((path) => [path, `${path}-wal`])
          .map(async (path) => {
            try {
              const stat = await wslGatedStat(path, 'scan', this.owner.signal)
              return `${path}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
            } catch (error) {
              throwIfAiVaultScanCancelled(this.owner.signal)
              return `${path}:${isMissingTranscriptPathError(error) ? 'missing' : 'unknown'}`
            }
          })
      )
    ).join('|')
    const old = this.containers.get(key)
    if (!this.force && old?.signature === signature && !signature.includes(':unknown')) {
      return { agent: old.discovery.agent, rootDir: old.discovery.rootDir, files: [] }
    }
    const discovery = await read()
    const membership = new Set<string>()
    const idsByContainer = new Map<string, Set<string>>()
    for (const file of discovery.files) {
      const synthetic = splitSyntheticSessionSource(file.path)
      if (!synthetic) {
        continue
      }
      membership.add(synthetic.id)
      const ids = idsByContainer.get(synthetic.container) ?? new Set<string>()
      ids.add(synthetic.id)
      idsByContainer.set(synthetic.container, ids)
    }
    if (discovery.complete === false) {
      return discovery
    }
    for (const [path, ids] of idsByContainer) {
      this.enumeratedContainers.set(path, ids)
    }
    if (old) {
      const current = new Set(discovery.files.map((file) => file.path))
      for (const file of old.discovery.files) {
        if (!current.has(file.path)) {
          this.removed.add(file.path)
        }
      }
    }
    this.containers.set(key, { signature, discovery, membership })
    return discovery
  }

  async end(): Promise<void> {
    await this.watchers.end()
    for (const key of this.roots.keys()) {
      if (!this.seen.has(key)) {
        this.roots.delete(key)
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
