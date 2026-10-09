import { lstat, realpath, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { ExecutionHostId } from '../../shared/execution-host'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { isWslUncPath } from '../../shared/wsl-paths'
import { isENOENT } from '../ipc/filesystem-path-containment'
import type { IFilesystemProvider } from '../providers/types'
import { resolveFilesystemRouteForHost } from '../providers/execution-host-provider-dispatch'
import { isSshRequestOutcomeUnverifiable } from '../ssh/ssh-channel-multiplexer'
import { wslUncDirectoryExistsAsync } from '../wsl'

export type HostPathKind = 'absent' | 'file' | 'directory' | 'symlink' | 'unverifiable'

/** The filesystem of the host that owns a repo, answered with absence kept apart from lost contact. */
export type RepoHostFilesystem = {
  /** Like lstat: a symlink reports `symlink`. */
  inspectEntry: (path: string) => Promise<HostPathKind>
  /** Like stat: follows links. */
  inspectTarget: (path: string) => Promise<HostPathKind>
  /** Null when the path is absent or the host cannot answer. */
  resolveRealPath: (path: string) => Promise<string | null>
  join: (base: string, segment: string) => string
}

function kindFromNodeStats(stats: {
  isSymbolicLink(): boolean
  isDirectory(): boolean
}): HostPathKind {
  if (stats.isSymbolicLink()) {
    return 'symlink'
  }
  return stats.isDirectory() ? 'directory' : 'file'
}

function kindFromLocalError(error: unknown): HostPathKind {
  return isDefinitiveAbsence(error) ? 'absent' : 'unverifiable'
}

function kindFromRemoteError(error: unknown): HostPathKind {
  // Why the message: relay errors cross JSON-RPC and lose Node's string code (see isENOENT).
  if (isENOENT(error) || (error instanceof Error && /\bENOTDIR\b/.test(error.message))) {
    return 'absent'
  }
  return 'unverifiable'
}

async function inspectWslTarget(path: string): Promise<HostPathKind> {
  // Why: Win32 stat on a WSL 9P share can falsely report ENOENT; ask the distro instead.
  const exists = await wslUncDirectoryExistsAsync(path)
  return exists === null ? 'unverifiable' : exists ? 'directory' : 'absent'
}

export const localRepoHostFilesystem: RepoHostFilesystem = {
  inspectEntry: async (path) => {
    if (process.platform === 'win32' && isWslUncPath(path)) {
      return inspectWslTarget(path)
    }
    try {
      return kindFromNodeStats(await lstat(path))
    } catch (error) {
      return kindFromLocalError(error)
    }
  },
  inspectTarget: async (path) => {
    if (process.platform === 'win32' && isWslUncPath(path)) {
      return inspectWslTarget(path)
    }
    try {
      return kindFromNodeStats(await stat(path))
    } catch (error) {
      return kindFromLocalError(error)
    }
  },
  resolveRealPath: async (path) => {
    try {
      return await realpath(path)
    } catch {
      return null
    }
  },
  join: (base, segment) => join(base, segment)
}

export function createSshRepoHostFilesystem(provider: IFilesystemProvider): RepoHostFilesystem {
  const inspect = async (path: string, followLinks: boolean): Promise<HostPathKind> => {
    if (!followLinks && provider.lstat) {
      try {
        return (await provider.lstat(path)).type
      } catch (error) {
        const kind = kindFromRemoteError(error)
        if (kind === 'absent' || isSshRequestOutcomeUnverifiable(error)) {
          return kind
        }
        // An old relay without lstat still answers stat; only symlink detection is lost.
      }
    }
    try {
      return (await provider.stat(path)).type
    } catch (error) {
      return kindFromRemoteError(error)
    }
  }
  return {
    inspectEntry: (path) => inspect(path, false),
    inspectTarget: (path) => inspect(path, true),
    resolveRealPath: async (path) => {
      try {
        return await provider.realpath(path)
      } catch {
        return null
      }
    },
    // Why posix: SSH hosts Orca supports are POSIX, whatever this client runs on.
    join: (base, segment) => posix.join(base, segment)
  }
}

/** Null when this process cannot reach the host: a runtime host answers for itself, an SSH host may be offline. */
export function resolveRepoHostFilesystem(hostId: ExecutionHostId): RepoHostFilesystem | null {
  const route = resolveFilesystemRouteForHost(hostId)
  if (route.kind === 'local') {
    return localRepoHostFilesystem
  }
  if (route.kind === 'ssh' && route.provider) {
    return createSshRepoHostFilesystem(route.provider)
  }
  return null
}
