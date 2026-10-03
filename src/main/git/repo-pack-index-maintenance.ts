import { posix, win32 } from 'node:path'
import { BoundedMap } from '../../shared/bounded-map'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { PackIndexMaintenanceOutcome } from '../../shared/repo-pack-index-maintenance-policy'
import type { RefMaintenanceSpan } from '../../shared/repo-ref-maintenance-policy'
import { probeRepoPackIndexDirectory, readRepoPackDirectoryStamp } from './repo-pack-index-state'
import { gitExecFileAsync } from './runner'

// Git's default auto-GC pack limit is 50; defer indexing until fragmentation is clear.
export const PACK_INDEX_THRESHOLD = 64
export const PACK_INDEX_TIMEOUT_MS = 60_000
export const PACK_INDEX_FORCE_REFRESH_MS = 6 * 60 * 60_000

const indexedDirectories = new BoundedMap<string, { stamp: string; writtenAt: number }>({
  maxEntries: 64
})

export function clearRepoPackIndexMaintenanceCache(): void {
  indexedDirectories.clear()
}

export function isUnsetGitConfigError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 1
}

type PackIndexMaintenanceArgs = {
  repoPath: string
  /** Common directory in the spelling the main process can open. */
  commonDir: string
  wslDistro?: string
  signal: AbortSignal
  span: RefMaintenanceSpan
  canWrite: () => boolean
}

export async function maintainRepoPackIndex(
  args: PackIndexMaintenanceArgs
): Promise<PackIndexMaintenanceOutcome> {
  const { signal, span } = args
  const outcome = (value: PackIndexMaintenanceOutcome): PackIndexMaintenanceOutcome => {
    span.setAttribute('git.pack_index_outcome', value)
    return value
  }
  if (signal.aborted) {
    return outcome('deferred')
  }
  const gitOptions = {
    cwd: args.repoPath,
    ...(args.wslDistro ? { wslDistro: args.wslDistro } : {}),
    admissionTier: 'background' as const,
    signal
  }
  try {
    try {
      const { stdout } = await gitExecFileAsync(
        ['config', '--bool', '--get', 'core.multiPackIndex'],
        gitOptions
      )
      const configured = stdout.trim()
      if (configured === 'false') {
        return outcome('opted_out')
      }
      if (configured !== 'true') {
        throw new Error('Unrecognized core.multiPackIndex config')
      }
    } catch (error) {
      if (!isUnsetGitConfigError(error)) {
        throw error
      }
    }
    if (signal.aborted) {
      return outcome('deferred')
    }
    const paths = isWindowsAbsolutePathLike(args.commonDir) ? win32 : posix
    const directory = paths.join(args.commonDir, 'objects', 'pack')
    const stamp = await readRepoPackDirectoryStamp(directory)
    if (!stamp) {
      return outcome('below_threshold')
    }
    const key = `${args.wslDistro ? `wsl:${args.wslDistro}` : 'local'}::${args.commonDir}`
    const previous = indexedDirectories.get(key)
    if (
      previous?.stamp === stamp &&
      Date.now() - previous.writtenAt < PACK_INDEX_FORCE_REFRESH_MS
    ) {
      return outcome('unchanged')
    }
    if (signal.aborted || !args.canWrite()) {
      return outcome('deferred')
    }
    const probe = await probeRepoPackIndexDirectory(directory, PACK_INDEX_THRESHOLD, signal)
    span.setAttribute('git.pack_index_pack_count_floor', probe.packCountFloor)
    if (signal.aborted || !args.canWrite()) {
      return outcome('deferred')
    }
    if (probe.protected) {
      return outcome('protected')
    }
    if (probe.packCountFloor < PACK_INDEX_THRESHOLD) {
      return outcome('below_threshold')
    }
    const startedAt = Date.now()
    // Git 2.20+: writes lookup metadata atomically without rewriting or deleting packs.
    // Let the writer finish: force-killing it on Windows can strand its index lock.
    await gitExecFileAsync(['multi-pack-index', 'write'], {
      cwd: args.repoPath,
      ...(args.wslDistro ? { wslDistro: args.wslDistro } : {}),
      admissionTier: 'background',
      timeout: PACK_INDEX_TIMEOUT_MS
    })
    const writtenStamp = await readRepoPackDirectoryStamp(directory).catch(() => undefined)
    // A racing new pack remains readable; the forced refresh bounds a missed directory change.
    if (writtenStamp) {
      indexedDirectories.set(key, { stamp: writtenStamp, writtenAt: Date.now() })
    }
    span.setAttribute('git.pack_index_write_ms', Date.now() - startedAt)
    return outcome('written')
  } catch (error) {
    span.setAttribute('git.pack_index_error', String(error))
    return outcome('failed')
  }
}
