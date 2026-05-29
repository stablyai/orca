import type { DockerEngineClientLike } from './docker-engine-client'
import {
  buildDockerImage,
  ORCA_DOCKER_MANAGED_LABEL,
  ORCA_DOCKER_REPO_LABEL
} from './docker-image-build'
import { DEFAULT_CONTAINER_WORKDIR, resolveDockerBindMount } from './docker-mount'
import type { DockerContainerHandle, DockerImageHandle } from './types'

const IMAGE_BUILD_TIMEOUT_MS = 60_000
const ORCA_DOCKER_KIND_LABEL = 'dev.orca.kind'
const repoBuildLocks = new Map<string, Promise<DockerImageHandle>>()

export type SpawnDockerContainerOptions = {
  repoPath: string
  worktreePath: string
  repoIdentity?: string
  engine: DockerEngineClientLike
  platform?: NodeJS.Platform
  workdir?: string
  now?: () => number
}

export type SpawnDockerContainerResult = {
  image: DockerImageHandle
  container: DockerContainerHandle
}

export async function spawnDockerContainer(
  options: SpawnDockerContainerOptions
): Promise<SpawnDockerContainerResult> {
  const workdir = options.workdir ?? DEFAULT_CONTAINER_WORKDIR
  const image = await buildImageOncePerRepo(options)
  const mount = resolveDockerBindMount({
    hostPath: options.worktreePath,
    platform: options.platform,
    containerPath: workdir
  })
  const created = await options.engine.createContainer({
    imageId: image.id,
    workdir,
    mounts: [mount],
    labels: {
      [ORCA_DOCKER_MANAGED_LABEL]: 'true',
      [ORCA_DOCKER_KIND_LABEL]: 'worktree',
      [ORCA_DOCKER_REPO_LABEL]: options.repoIdentity ?? options.repoPath
    }
  })
  await options.engine.startContainer(created.id)

  return {
    image,
    container: {
      id: created.id,
      imageId: image.id,
      startedAt: (options.now ?? Date.now)(),
      state: 'running'
    }
  }
}

export async function attachDockerContainer(
  engine: DockerEngineClientLike,
  id: string,
  now: () => number = Date.now
): Promise<DockerContainerHandle> {
  const info = await engine.inspectContainer(id)
  if (!info.running) {
    throw new Error(`Docker container ${id} is not running`)
  }
  assertOrcaManagedContainer(id, info.labels)
  return {
    id: info.id,
    imageId: info.imageId,
    startedAt: now(),
    state: 'running'
  }
}

export async function hibernateDockerContainer(
  engine: DockerEngineClientLike,
  container: DockerContainerHandle
): Promise<DockerContainerHandle> {
  const info = await engine.inspectContainer(container.id)
  assertOrcaManagedContainer(container.id, info.labels)
  await engine.stopContainer(container.id)
  return { ...container, state: 'hibernated' }
}

export async function terminateDockerContainer(
  engine: DockerEngineClientLike,
  container: DockerContainerHandle
): Promise<DockerContainerHandle> {
  if (container.state !== 'terminated') {
    const info = await engine.inspectContainer(container.id)
    assertOrcaManagedContainer(container.id, info.labels)
    await engine.stopContainer(container.id)
    await engine.removeContainer(container.id)
  }
  return { ...container, state: 'terminated' }
}

function assertOrcaManagedContainer(id: string, labels: Record<string, string> | undefined): void {
  // Why: cleanup accepts an opaque Docker id. Require Orca's label before
  // stopping or removing anything so a stale handle cannot target user-owned containers.
  if (
    labels?.[ORCA_DOCKER_MANAGED_LABEL] !== 'true' ||
    labels?.[ORCA_DOCKER_KIND_LABEL] !== 'worktree'
  ) {
    throw new Error(`Docker container ${id} is not managed by Orca`)
  }
}

async function buildImageOncePerRepo(
  options: SpawnDockerContainerOptions
): Promise<DockerImageHandle> {
  const key = options.repoIdentity ?? options.repoPath
  const existing = repoBuildLocks.get(key)
  if (existing) {
    return existing
  }

  const next = buildDockerImage({
    repoPath: options.repoPath,
    repoIdentity: options.repoIdentity,
    engine: options.engine,
    timeoutMs: IMAGE_BUILD_TIMEOUT_MS,
    now: options.now
  }).finally(() => {
    repoBuildLocks.delete(key)
  })
  repoBuildLocks.set(key, next)
  return next
}
