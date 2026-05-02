import path from 'path'

export type DockerBindMount = {
  source: string
  target: string
  readonly?: boolean
}

export type ResolveDockerBindMountOptions = {
  hostPath: string
  platform?: NodeJS.Platform
  containerPath?: string
  readonly?: boolean
}

export const DEFAULT_CONTAINER_WORKDIR = path.posix.join(path.posix.sep, 'workspace')

export function resolveDockerBindMount(options: ResolveDockerBindMountOptions): DockerBindMount {
  const platform = options.platform ?? process.platform
  const source =
    platform === 'win32' ? translateWindowsPathForWsl2(options.hostPath) : options.hostPath

  return {
    source,
    target: options.containerPath ?? DEFAULT_CONTAINER_WORKDIR,
    readonly: options.readonly
  }
}

export function translateWindowsPathForWsl2(hostPath: string): string {
  const normalized = hostPath.replace(/\//g, '\\')
  const driveMatch = normalized.match(/^([A-Za-z]):\\(.*)$/)
  if (!driveMatch) {
    return hostPath
  }

  const drive = driveMatch[1].toLowerCase()
  const rest = driveMatch[2].split('\\').filter(Boolean)
  // Why: Docker Desktop's WSL2 backend sees Windows drives at /mnt/<drive>,
  // so bind mounts must use that Linux path instead of the Win32 host path.
  return path.posix.join(path.posix.sep, 'mnt', drive, ...rest)
}
