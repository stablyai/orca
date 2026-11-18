import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginGitConfigArgs } from '../../../shared/plugins/installation/plugin-git-arguments'
import { readRetainedPluginGitCommit, runPluginGit } from '../installation/plugin-git-repository'
import type { PluginMarketplaceRegisteredSource } from './plugin-marketplace-store'
import { readCatalogImageBlobs } from './plugin-catalog-blob-reader'

const CATALOG_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024

/** Serializes readers with refresh/pruning so a snapshot's objects cannot disappear mid-read. */
export class PluginCatalogRepositoryStore {
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly root: string

  constructor(pluginsDataDir: string) {
    this.root = join(pluginsDataDir, 'catalog-repositories')
  }

  private directory(sourceId: string): string {
    if (!/^[0-9a-f]{32}$/.test(sourceId)) {
      throw new Error('invalid catalog source identity')
    }
    return join(this.root, sourceId)
  }

  private async serial<T>(sourceId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(sourceId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(run)
    this.pending.set(sourceId, next)
    try {
      return await next
    } finally {
      if (this.pending.get(sourceId) === next) {
        this.pending.delete(sourceId)
      }
    }
  }

  refresh<T>(
    source: PluginMarketplaceRegisteredSource,
    read: (repository: string, commit: string) => Promise<T>,
    publishedCommit?: string
  ): Promise<{ commit: string; value: T }> {
    return this.serial(source.id, () =>
      readRetainedPluginGitCommit(
        {
          url: source.source.url,
          ref: source.source.ref,
          directory: this.directory(source.id),
          maxDownloadBytes: CATALOG_DOWNLOAD_MAX_BYTES,
          publishedCommit
        },
        read
      )
    )
  }

  publish(sourceId: string, commit: string): Promise<void> {
    return this.serial(sourceId, async () => {
      if (!/^[0-9a-f]{40}$/.test(commit)) {
        throw new Error('invalid catalog commit')
      }
      const directory = this.directory(sourceId)
      const hooks = join(directory, 'no-hooks')
      const config = pluginGitConfigArgs(hooks)
      const repository = join(directory, 'repository')
      await runPluginGit([...config, 'update-ref', 'refs/orca/snapshot', commit], repository)
      await runPluginGit([...config, 'update-ref', '-d', 'refs/orca/fetched'], repository)
      await runPluginGit([...config, 'reflog', 'expire', '--expire=now', '--all'], repository)
      await runPluginGit([...config, '-c', 'pack.threads=2', 'gc', '--prune=now'], repository)
    })
  }

  readImages(
    sourceId: string,
    commit: string,
    paths: ReadonlyMap<string, number>
  ): Promise<Map<string, Buffer>> {
    return this.serial(sourceId, () =>
      readCatalogImageBlobs(join(this.directory(sourceId), 'repository'), commit, paths)
    )
  }

  remove(sourceId: string): Promise<void> {
    return this.serial(sourceId, () =>
      rm(this.directory(sourceId), { recursive: true, force: true })
    )
  }
}
