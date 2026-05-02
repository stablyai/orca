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
  const tag = `orca-worktree:${cacheKey.slice(0, 24)}`

  const result = await options.engine.buildImage({
    contextPath: options.repoPath,
    dockerfilePath: dockerfile.dockerfilePath,
    dockerfileContent: dockerfile.isGenerated ? dockerfile.content : undefined,
    tag,
    timeoutMs: options.timeoutMs
  })

  return {
    id: result.imageId,
    cacheKey,
    dockerfilePath: dockerfile.dockerfilePath,
    builtAt: (options.now ?? Date.now)()
  }
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
