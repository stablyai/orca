import { DockerEngineClient, type DockerEngineClientLike } from '../docker/docker-engine-client'
import {
  spawnDockerContainer,
  terminateDockerContainer,
  type SpawnDockerContainerResult
} from '../docker/docker-container-lifecycle'
import { DEFAULT_CONTAINER_WORKDIR } from '../docker/docker-mount'
import type { DockerContainerHandle, DockerTarget } from '../docker/types'

type DockerContainerEntry = SpawnDockerContainerResult & {
  target: DockerTarget
}

export class DockerContainerRegistry {
  private engine: DockerEngineClientLike
  private entries = new Map<string, DockerContainerEntry>()
  private pending = new Map<string, Promise<DockerContainerEntry>>()

  constructor(engine: DockerEngineClientLike = new DockerEngineClient()) {
    this.engine = engine
  }

  getEngineClient(): DockerEngineClientLike {
    return this.engine
  }

  async getOrCreateContainer(worktreeId: string, repoPath: string): Promise<DockerContainerHandle> {
    return (await this.getOrCreateEntry(worktreeId, repoPath)).container
  }

  async getOrCreateTarget(worktreeId: string, repoPath: string): Promise<DockerTarget> {
    return (await this.getOrCreateEntry(worktreeId, repoPath)).target
  }

  async terminateContainer(worktreeId: string): Promise<void> {
    const pending = this.pending.get(worktreeId)
    if (pending) {
      await pending.catch(() => null)
    }
    const entry = this.entries.get(worktreeId)
    if (!entry) {
      return
    }
    this.entries.delete(worktreeId)
    await terminateDockerContainer(this.engine, entry.container)
  }

  async terminateAll(): Promise<void> {
    const worktreeIds = [...new Set([...this.pending.keys(), ...this.entries.keys()])]
    await Promise.all(worktreeIds.map((worktreeId) => this.terminateContainer(worktreeId)))
  }

  private async getOrCreateEntry(
    worktreeId: string,
    repoPath: string
  ): Promise<DockerContainerEntry> {
    const existing = this.entries.get(worktreeId)
    if (existing && (await this.isRunning(existing.container))) {
      return existing
    }
    this.entries.delete(worktreeId)

    const pending = this.pending.get(worktreeId)
    if (pending) {
      return pending
    }

    const next = this.spawnEntry(worktreeId, repoPath).finally(() => {
      this.pending.delete(worktreeId)
    })
    this.pending.set(worktreeId, next)
    return next
  }

  private async spawnEntry(worktreeId: string, repoPath: string): Promise<DockerContainerEntry> {
    const spawned = await spawnDockerContainer({
      repoPath,
      worktreePath: repoPath,
      repoIdentity: worktreeId,
      engine: this.engine,
      workdir: DEFAULT_CONTAINER_WORKDIR
    })
    const entry = {
      ...spawned,
      target: {
        containerId: spawned.container.id,
        image: spawned.image,
        workdir: DEFAULT_CONTAINER_WORKDIR
      }
    }
    this.entries.set(worktreeId, entry)
    return entry
  }

  private async isRunning(container: DockerContainerHandle): Promise<boolean> {
    if (container.state !== 'running') {
      return false
    }
    try {
      return (await this.engine.inspectContainer(container.id)).running
    } catch {
      return false
    }
  }
}

export const dockerContainerRegistry = new DockerContainerRegistry()
