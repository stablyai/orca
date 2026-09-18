import {
  ApfsCloneUnavailableError,
  canCloneWithApfs,
  cloneWorktreePathWithApfs,
  defaultApfsCloneDeps,
  type ApfsCloneDeps,
  type DarwinFilesystemCache
} from './worktree-apfs-clone'
import {
  canCloneWithRefs,
  cloneWorktreePathWithRefs,
  defaultRefsCloneDeps,
  RefsCloneUnavailableError,
  type RefsCloneDeps,
  type RefsFilesystemCache
} from './worktree-refs-clone'

export type CopyOnWriteCloneOptions = {
  platform: NodeJS.Platform
  cloneWorktreePath?: (source: string, target: string, sourceIsDirectory: boolean) => Promise<void>
  apfsCloneDeps?: ApfsCloneDeps
  refsCloneDeps?: RefsCloneDeps
}

export type CopyOnWriteFilesystemCaches = {
  apfs: DarwinFilesystemCache
  refs: RefsFilesystemCache
}

export function copyOnWriteCloneName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'ReFS block clone' : 'APFS clone-copy'
}

export function isCopyOnWriteCloneUnavailable(error: unknown): boolean {
  return error instanceof ApfsCloneUnavailableError || error instanceof RefsCloneUnavailableError
}

export async function canCloneWorktreePathCopyOnWrite(
  source: string,
  targetDirectory: string,
  options: CopyOnWriteCloneOptions,
  caches: CopyOnWriteFilesystemCaches
): Promise<boolean> {
  if (options.platform !== 'darwin' && options.platform !== 'win32') {
    return false
  }
  if (options.cloneWorktreePath) {
    return true
  }
  if (options.platform === 'win32') {
    return await canCloneWithRefs(
      source,
      targetDirectory,
      options.refsCloneDeps ?? defaultRefsCloneDeps,
      caches.refs
    )
  }
  return await canCloneWithApfs(
    source,
    targetDirectory,
    options.apfsCloneDeps ?? defaultApfsCloneDeps,
    caches.apfs
  )
}

export async function cloneWorktreePathCopyOnWrite(
  source: string,
  target: string,
  sourceIsDirectory: boolean,
  options: CopyOnWriteCloneOptions,
  caches: CopyOnWriteFilesystemCaches
): Promise<void> {
  if (options.cloneWorktreePath) {
    await options.cloneWorktreePath(source, target, sourceIsDirectory)
  } else if (options.platform === 'win32') {
    await cloneWorktreePathWithRefs(
      source,
      target,
      sourceIsDirectory,
      options.refsCloneDeps ?? defaultRefsCloneDeps
    )
  } else {
    await cloneWorktreePathWithApfs(
      source,
      target,
      sourceIsDirectory,
      options.apfsCloneDeps ?? defaultApfsCloneDeps,
      caches.apfs
    )
  }
}
