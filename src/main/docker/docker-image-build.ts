import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { createHash } from 'crypto'
import path from 'path'
import type { DockerEngineClientLike } from './docker-engine-client'
import type { DockerImageHandle } from './types'

const DEFAULT_DOCKERFILE_CONTENT = `FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git nodejs npm ripgrep && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
`
const DEFAULT_DOCKERFILE_PATH = 'auto-generated:orca-default'
export const ORCA_DOCKER_MANAGED_LABEL = 'dev.orca.managed'
export const ORCA_DOCKER_REPO_LABEL = 'dev.orca.repo'
export const ORCA_DOCKER_CACHE_KEY_LABEL = 'dev.orca.cache-key'
export const ORCA_DOCKER_DOCKERFILE_PATH_LABEL = 'dev.orca.dockerfile-path'
export const ORCA_DOCKER_IMAGE_LABEL = ORCA_DOCKER_MANAGED_LABEL
export const ORCA_DOCKER_IMAGE_TAG_REPOSITORY = 'orca-worktree'

export type DockerImageCacheIndexEntry = DockerImageHandle & {
  repoIdentity: string
  tag: string
  lastUsedAt: number
}

const imageCacheIndex = new Map<string, DockerImageCacheIndexEntry>()

export type ResolveDockerfileResult = {
  dockerfilePath: string
  content: string
  isGenerated: boolean
}

export type BuildDockerImageOptions = {
  repoPath: string
  repoIdentity?: string
  engine: DockerEngineClientLike
  timeoutMs?: number
  now?: () => number
}

export async function resolveDockerfile(repoPath: string): Promise<ResolveDockerfileResult> {
  const devcontainerDockerfile = path.join(repoPath, '.devcontainer', 'Dockerfile')
  if (existsSync(devcontainerDockerfile)) {
    return {
      dockerfilePath: devcontainerDockerfile,
      content: await readFile(devcontainerDockerfile, 'utf-8'),
      isGenerated: false
    }
  }

  const orcaDockerfile = path.join(repoPath, '.orca', 'Dockerfile')
  if (existsSync(orcaDockerfile)) {
    return {
      dockerfilePath: orcaDockerfile,
      content: await readFile(orcaDockerfile, 'utf-8'),
      isGenerated: false
    }
  }

  return {
    dockerfilePath: DEFAULT_DOCKERFILE_PATH,
    content: DEFAULT_DOCKERFILE_CONTENT,
    isGenerated: true
  }
}

export async function buildDockerImage(
  options: BuildDockerImageOptions
): Promise<DockerImageHandle> {
  const dockerfile = await resolveDockerfile(options.repoPath)
  const cacheKey = computeDockerImageCacheKey({
    dockerfileContent: dockerfile.content,
    repoIdentity: options.repoIdentity ?? options.repoPath
  })
  const repoIdentity = options.repoIdentity ?? options.repoPath
  const tag = getOrcaDockerImageTag(cacheKey)
  const timestamp = (options.now ?? Date.now)()

  const result = await options.engine.buildImage({
    contextPath: options.repoPath,
    dockerfilePath: dockerfile.dockerfilePath,
    dockerfileContent: dockerfile.isGenerated ? dockerfile.content : undefined,
    tag,
    timeoutMs: options.timeoutMs,
    labels: {
      [ORCA_DOCKER_MANAGED_LABEL]: 'true',
      [ORCA_DOCKER_REPO_LABEL]: repoIdentity,
      [ORCA_DOCKER_CACHE_KEY_LABEL]: cacheKey,
      [ORCA_DOCKER_DOCKERFILE_PATH_LABEL]: dockerfile.dockerfilePath
    }
  })

  const handle = {
    id: result.imageId,
    cacheKey,
    dockerfilePath: dockerfile.dockerfilePath,
    builtAt: timestamp,
    lastUsedAt: timestamp
  }
  imageCacheIndex.set(cacheKey, { ...handle, repoIdentity, tag, lastUsedAt: timestamp })
  return handle
}

export function computeDockerImageCacheKey(input: {
  dockerfileContent: string
  repoIdentity: string
}): string {
  // Why: tying the image cache to both Dockerfile content and repo identity
  // prevents two unrelated repos with identical Dockerfiles from sharing setup.
  return createHash('sha256')
    .update(input.repoIdentity)
    .update('\0')
    .update(input.dockerfileContent)
    .digest('hex')
}

export function getOrcaDockerImageTag(cacheKey: string): string {
  return `${ORCA_DOCKER_IMAGE_TAG_REPOSITORY}:${cacheKey.slice(0, 24)}`
}

export function isOrcaDockerImageTag(repoTags: string[], cacheKey: string): boolean {
  return repoTags.includes(getOrcaDockerImageTag(cacheKey))
}

export function getDockerImageCacheIndex(): DockerImageCacheIndexEntry[] {
  return [...imageCacheIndex.values()]
}

export function removeDockerImageCacheIndexEntry(cacheKey: string): void {
  imageCacheIndex.delete(cacheKey)
}
