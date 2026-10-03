import {
  canCloneWithApfs,
  cloneWorktreePathWithApfs,
  defaultApfsCloneDeps,
  type ApfsCloneDeps,
  type DarwinFilesystemCache
} from './worktree-apfs-clone'
import {
  canCloneWithReflink,
  cloneWorktreePathWithReflink,
  defaultReflinkCloneDeps,
  type ReflinkCloneDeps,
  type ReflinkFilesystemCache
} from './worktree-reflink-clone'

export type CloneWorktreePath = (
  source: string,
  target: string,
  sourceIsDirectory: boolean
) => Promise<void>

export type CopyOnWriteBackendOptions = {
  /** Stands in for the platform clone (tests). Only consulted on platforms
   *  that have one. */
  cloneWorktreePath?: CloneWorktreePath
  apfsCloneDeps?: ApfsCloneDeps
  reflinkCloneDeps?: ReflinkCloneDeps
}

/** The copy-on-write clone a platform offers: APFS `clonefile` on macOS,
 *  `FICLONE` reflink on Linux (btrfs, XFS, OpenZFS 2.2+). Both give a worktree
 *  a private copy that costs metadata rather than bytes and need no privilege
 *  or filesystem layout — which is why neither a dataset nor a subvolume
 *  snapshot/clone is used here. */
export type CopyOnWriteBackend = {
  label: 'APFS' | 'reflink'
  clone: CloneWorktreePath
  /** Answers without materializing the path, so a caller can size the work
   *  before any bytes land. */
  canClone: (source: string, targetDirectory: string) => Promise<boolean>
}

// An injected clone stands in for the real one, so treat it as cloning —
// probing the real filesystem would make those tests host-dependent.
const alwaysClones = async (): Promise<boolean> => true

/** Resolve once per materialization: each backend caches its filesystem probe
 *  across every path it is asked about, and the cache lives here. Returns null
 *  where the platform has no clone (Windows). */
export function resolveCopyOnWriteBackend(
  platform: NodeJS.Platform,
  options: CopyOnWriteBackendOptions
): CopyOnWriteBackend | null {
  const injected = options.cloneWorktreePath
  if (platform === 'darwin') {
    const deps = options.apfsCloneDeps ?? defaultApfsCloneDeps
    // Why: one df+diskutil probe per distinct volume for the whole
    // materialization, not per copied path — see DarwinFilesystemCache.
    const cache: DarwinFilesystemCache = new Map()
    return {
      label: 'APFS',
      clone:
        injected ??
        ((source, target, sourceIsDirectory) =>
          cloneWorktreePathWithApfs(source, target, sourceIsDirectory, deps, cache)),
      canClone: injected
        ? alwaysClones
        : (source, targetDirectory) => canCloneWithApfs(source, targetDirectory, deps, cache)
    }
  }
  if (platform === 'linux') {
    const deps = options.reflinkCloneDeps ?? defaultReflinkCloneDeps
    const cache: ReflinkFilesystemCache = new Map()
    return {
      label: 'reflink',
      clone:
        injected ??
        ((source, target, sourceIsDirectory) =>
          cloneWorktreePathWithReflink(source, target, sourceIsDirectory, deps, cache)),
      canClone: injected
        ? alwaysClones
        : (source, targetDirectory) => canCloneWithReflink(source, targetDirectory, deps, cache)
    }
  }
  return null
}
