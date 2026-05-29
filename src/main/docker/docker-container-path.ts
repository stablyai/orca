import path from 'path'
import type { DockerTarget } from './types'

type HostPathApi = Pick<typeof path, 'isAbsolute' | 'relative' | 'resolve' | 'sep'>

function normalizeContainerRoot(workdir: string): string {
  const normalized = path.posix.resolve(path.posix.sep, workdir.replace(/\\/g, '/'))
  if (normalized === path.posix.sep) {
    throw new Error('Docker workdir must not be the container root')
  }
  return normalized
}

function isInsideOrEqual(
  pathApi: Pick<typeof path, 'isAbsolute' | 'relative' | 'sep'>,
  root: string,
  candidate: string
): boolean {
  const relative = pathApi.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative))
}

function getHostPathApi(platform: NodeJS.Platform): HostPathApi {
  return platform === 'win32' ? path.win32 : path
}

function getHostRelativePath(target: DockerTarget, inputPath: string): string | null {
  if (!target.hostWorktreePath) {
    return null
  }
  const hostPathApi = getHostPathApi(target.hostPlatform ?? process.platform)
  if (!hostPathApi.isAbsolute(inputPath)) {
    return null
  }
  const root = hostPathApi.resolve(target.hostWorktreePath)
  const candidate = hostPathApi.resolve(inputPath)
  if (!isInsideOrEqual(hostPathApi, root, candidate)) {
    return null
  }
  return hostPathApi.relative(root, candidate)
}

export function resolveDockerContainerPath(target: DockerTarget, inputPath: string): string {
  if (inputPath.includes('\0')) {
    throw new Error('Docker container path must not contain null bytes')
  }

  const root = normalizeContainerRoot(target.workdir)
  const hostRelativePath = getHostRelativePath(target, inputPath)
  const candidate =
    hostRelativePath !== null
      ? path.posix.resolve(root, hostRelativePath.replace(/\\/g, '/'))
      : path.posix.isAbsolute(inputPath.replace(/\\/g, '/'))
        ? path.posix.resolve(inputPath.replace(/\\/g, '/'))
        : path.posix.resolve(root, inputPath.replace(/\\/g, '/'))

  if (!isInsideOrEqual(path.posix, root, candidate)) {
    throw new Error(`Docker path "${inputPath}" resolves outside ${root}`)
  }
  return candidate
}

export function resolveDockerContainerRelativePath(
  target: DockerTarget,
  inputPath: string
): string {
  const root = normalizeContainerRoot(target.workdir)
  const resolved = resolveDockerContainerPath(target, inputPath)
  const relative = path.posix.relative(root, resolved)
  return relative || '.'
}

export function normalizeDockerMountTarget(containerPath: string): string {
  if (containerPath.includes('\0')) {
    throw new Error('Docker mount target must not contain null bytes')
  }
  const normalized = path.posix.resolve(path.posix.sep, containerPath.replace(/\\/g, '/'))
  if (normalized === path.posix.sep) {
    throw new Error('Docker mount target must not be the container root')
  }
  return normalized
}
