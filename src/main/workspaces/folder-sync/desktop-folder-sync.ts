import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import type { Repo } from '../../../shared/repository/repo-types'
import {
  type FolderProjectSyncPreference,
  FolderReplicaResult,
  FolderSyncManifest,
  type FolderProjectSetupRequest,
  type FolderProjectSyncStatus,
  type FolderProjectSyncTarget
} from '../../../shared/project/folder-project-sync'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host/execution-host'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import {
  folderSyncTargetKey,
  readFolderSyncState,
  writeFolderSyncState,
  type StoredFolderSync
} from './folder-sync-state'
import { scanFolderSyncManifest } from './folder-sync-manifest'
import { planFolderSync, type FolderSyncPair } from './folder-sync-plan'
import { FolderSyncTransport, resolveFolderSyncServer } from './folder-sync-transfer'

const FOLDER_SYNC_INTERVAL_MS = 30_000

export class DesktopFolderSync {
  private readonly links = new Map<string, StoredFolderSync>()
  private readonly status = new Map<string, Pick<FolderProjectSyncStatus, 'conflicts' | 'error'>>()
  private readonly running = new Map<string, AbortController>()
  private readonly ready: Promise<void>
  private writes = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(
    private readonly userDataPath: string,
    private readonly statePath: string,
    private readonly getRepos: () => readonly Repo[]
  ) {
    this.ready = readFolderSyncState(statePath).then((rows) => {
      for (const row of rows) {
        this.links.set(folderSyncTargetKey(row), row)
      }
      this.schedule()
    })
    void this.ready.catch(() => {})
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    for (const controller of this.running.values()) {
      controller.abort()
    }
  }

  async getStatus(target: FolderProjectSyncTarget): Promise<FolderProjectSyncStatus | null> {
    await this.ready
    const key = folderSyncTargetKey(target)
    const link = this.links.get(key)
    return link
      ? {
          conflicts: [],
          ...this.status.get(key),
          autoSync: link.autoSync,
          pendingCopy: link.pendingCopy
        }
      : null
  }

  async setup(request: FolderProjectSetupRequest): Promise<FolderReplicaResult> {
    await this.ready
    const key = folderSyncTargetKey(request)
    return this.run(key, async (signal) => {
      const local = this.requireLocalSource(request.sourceRepoId)
      const path = await realpath(windowsFsPath(local.path))
      const source = { ...local, path }
      const server = await resolveFolderSyncServer(this.userDataPath, request.environmentId, signal)
      const transport = new FolderSyncTransport(this.userDataPath, server, signal)
      const { repo: remote } = z.object({ repo: FolderReplicaResult }).parse(
        await transport.call('projectHostSetup.createFolderReplica', {
          sourceRepoId: local.id,
          name: local.displayName.slice(0, 160)
        })
      )
      if (remote.folderProjectSourceId !== local.id) {
        throw new Error('Server returned an unrelated project folder.')
      }
      const link: StoredFolderSync = {
        environmentId: server.environmentId,
        pairingRevision: server.pairingRevision,
        sourceRepoId: local.id,
        autoSync: false,
        pendingCopy: request.copyContents,
        localPath: local.path,
        resolvedLocalPath: path,
        remote
      }
      if (link.pendingCopy) {
        await this.save(key, link, signal)
      }
      signal.throwIfAborted()
      const baseline =
        request.copyContents || request.autoSync
          ? await this.scan(transport, source, remote)
          : undefined
      if (request.copyContents && baseline) {
        const { changes, conflicts } = planFolderSync([[], []], baseline)
        if (conflicts.length) {
          throw new Error(
            `Could not copy ${conflicts[0]}. The path is unsupported or the server has a different version.`
          )
        }
        for (const change of changes) {
          if (change.from === 0 && change.entry) {
            await transport.apply(source, remote, 0, change)
            baseline[1].push([change.path, change.entry])
          }
        }
      }
      await this.save(
        key,
        { ...link, autoSync: request.autoSync, pendingCopy: false, baseline },
        signal
      )
      this.status.delete(key)
      this.schedule()
      return remote
    })
  }

  async setPreference(request: FolderProjectSyncPreference): Promise<FolderProjectSyncStatus> {
    await this.ready
    const key = folderSyncTargetKey(request)
    const link = this.links.get(key)
    if (!link || link.pendingCopy) {
      throw new Error('Folder project sync is not configured.')
    }
    if (!request.autoSync) {
      this.running.get(key)?.abort()
      await this.save(key, { ...link, autoSync: false })
      this.status.delete(key)
    } else if (!link.autoSync) {
      await this.run(key, async (signal) => {
        const local = await this.getLinkedLocalRepo(link)
        const server = await resolveFolderSyncServer(
          this.userDataPath,
          link.environmentId,
          signal,
          link.pairingRevision
        )
        const transport = new FolderSyncTransport(this.userDataPath, server, signal)
        const baseline = link.baseline ?? (await this.scan(transport, local, link.remote))
        await this.save(key, { ...link, autoSync: true, baseline }, signal)
        this.schedule()
      })
    }
    return { conflicts: [], ...this.status.get(key), autoSync: request.autoSync }
  }

  private async sync(link: StoredFolderSync, signal: AbortSignal): Promise<void> {
    const before = link.baseline
    if (!before) {
      return
    }
    const local = await this.getLinkedLocalRepo(link)
    const remote = link.remote
    const server = await resolveFolderSyncServer(
      this.userDataPath,
      link.environmentId,
      signal,
      link.pairingRevision
    )
    const transport = new FolderSyncTransport(this.userDataPath, server, signal)
    const after = await this.scan(transport, local, remote)
    const { changes, conflicts } = planFolderSync(before, after)
    const next = [new Map(after[0]), new Map(after[1])] as const
    let firstError: string | undefined
    for (const change of changes) {
      signal.throwIfAborted()
      try {
        await transport.apply(local, remote, change.from, change)
        const updated = next[1 - change.from]
        if (change.entry) {
          updated.set(change.path, change.entry)
        } else {
          updated.delete(change.path)
        }
      } catch (error) {
        conflicts.push(change.path)
        firstError ??= error instanceof Error ? error.message : String(error)
      }
    }
    const preserveBaseline = (index: 0 | 1): FolderSyncManifest => {
      const prior = new Map(before[index])
      for (const path of conflicts) {
        const old = prior.get(path)
        if (old) {
          next[index].set(path, old)
        } else {
          next[index].delete(path)
        }
      }
      return [...next[index]].sort(([a], [b]) => a.localeCompare(b))
    }
    const baseline: FolderSyncPair = [preserveBaseline(0), preserveBaseline(1)]
    signal.throwIfAborted()
    const key = folderSyncTargetKey(link)
    if (JSON.stringify(link.baseline) !== JSON.stringify(baseline)) {
      await this.save(key, { ...link, baseline }, signal)
    }
    this.status.set(key, { conflicts: conflicts.slice(0, 10), error: firstError })
  }

  private scan(
    transport: FolderSyncTransport,
    local: Repo,
    remote: Pick<Repo, 'id' | 'path'>
  ): Promise<FolderSyncPair> {
    return Promise.all([
      scanFolderSyncManifest(local.path),
      transport
        .call('projectHostSetup.folderReplicaManifest', {
          repoId: remote.id,
          expectedPath: remote.path,
          sourceRepoId: local.id
        })
        .then((manifest) => FolderSyncManifest.parse(manifest))
    ])
  }

  private requireLocalSource(id: string): Repo {
    const repo = this.getRepos().find(
      (row) =>
        row.id === id &&
        row.kind === 'folder' &&
        !row.folderProjectSourceId &&
        getRepoExecutionHostId(row) === LOCAL_EXECUTION_HOST_ID
    )
    if (!repo) {
      throw new Error('Local folder project is no longer registered.')
    }
    return repo
  }

  private async getLinkedLocalRepo(link: StoredFolderSync): Promise<Repo> {
    const repo = this.requireLocalSource(link.sourceRepoId)
    if (
      repo.path !== link.localPath ||
      (await realpath(windowsFsPath(repo.path))) !== link.resolvedLocalPath
    ) {
      throw new Error('The local project folder has moved.')
    }
    return { ...repo, path: link.resolvedLocalPath }
  }

  private async run<T>(key: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed || this.running.has(key)) {
      throw new Error('Folder project sync is already running.')
    }
    const controller = new AbortController()
    this.running.set(key, controller)
    try {
      return await fn(controller.signal)
    } finally {
      this.running.delete(key)
    }
  }

  private save(key: string, link: StoredFolderSync, signal?: AbortSignal): Promise<void> {
    const write = this.writes.then(async () => {
      signal?.throwIfAborted()
      const next = new Map(this.links).set(key, link)
      await writeFolderSyncState(this.statePath, [...next.values()])
      this.links.set(key, link)
    })
    this.writes = write.catch(() => {})
    return write
  }

  private schedule(): void {
    if (!this.disposed && !this.timer && [...this.links.values()].some((row) => row.autoSync)) {
      this.timer = setTimeout(() => void this.tick(), FOLDER_SYNC_INTERVAL_MS)
      this.timer.unref()
    }
  }

  private async tick(): Promise<void> {
    try {
      for (const [key, link] of this.links) {
        if (!link.autoSync || this.running.has(key) || this.disposed) {
          continue
        }
        await this.run(key, async (signal) => {
          try {
            await this.sync(link, signal)
          } catch (error) {
            if (!signal.aborted) {
              this.status.set(key, {
                conflicts: [],
                error: error instanceof Error ? error.message : String(error)
              })
            }
          }
        })
      }
    } finally {
      this.timer = undefined
      this.schedule()
    }
  }
}
