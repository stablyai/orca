import type {
  RuntimeFileOpenPosition,
  RuntimeFileOpenResult
} from '../../../shared/file-access/runtime-editor-file-open'
import { listFilesystemMarkdownDocuments } from '../../providers/filesystem-markdown-listing'
import type { MarkdownDocument } from '../../../shared/file-listing/file-document'
import {
  validatePathExistenceBatch,
  type PathExistenceResult
} from '../../../shared/file-access/path-existence-batch'
import { readRuntimeFilePathExistence } from './file-path-existence'
import {
  FILE_STAT_MANY_MAX,
  type FileStatManyEntry,
  type FileStatManyResult
} from '../../../shared/file-access/file-stat-many'
import {
  isMobileBinaryPath,
  isMobileMarkdownPath,
  isSafeMobileRelativePath,
  isMobilePreviewableImagePath
} from './mobile-file-kind'
import type { RuntimeFileCommandHost } from './file-command-host'
import type { RuntimeNavigationTarget } from '../../../shared/runtime-navigation'
import { joinWorktreeRelativePath } from './paths/runtime-relative-paths'
import {
  isENOENT,
  isPathAbsentError
} from '../../ipc/filesystem/access/filesystem-path-containment'
import {
  requireRuntimeFileProvider,
  resolveFileExplorerPath,
  resolveFileExplorerPaths
} from './file-target'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { FileStat } from '../../providers/filesystem-provider-contract'
import { assertRuntimeReadWslDistroRunning } from '../integrations/git/runtime-wsl-background-read-gate'

const STAT_MANY_CONCURRENCY = 32

type RuntimeFileAccessHost = Pick<
  RuntimeFileCommandHost,
  'requireStore' | 'resolveRuntimeFileTarget' | 'openFile' | 'openDiff'
>

export class RuntimeFileAccess {
  constructor(private readonly host: RuntimeFileAccessHost) {}

  async openMobileFile(
    worktreeSelector: string,
    relativePath: string,
    navigation?: RuntimeNavigationTarget,
    position?: RuntimeFileOpenPosition
  ): Promise<RuntimeFileOpenResult> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    const kind = isMobilePreviewableImagePath(relativePath)
      ? 'image'
      : isMobileBinaryPath(relativePath)
        ? 'binary'
        : isMobileMarkdownPath(relativePath)
          ? 'markdown'
          : 'text'
    // File kind does not limit the desktop editor: binaries such as PDFs can open too.
    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    // Reject missing paths/directories before clients treat opened:true as success.
    await this.assertOpenTargetIsFile(filePath, target)
    await this.host.openFile(
      worktree.id,
      filePath,
      relativePath,
      runtimeOwnerForTarget(target),
      navigation,
      ...(position ? [position] : [])
    )
    return { worktree: worktree.id, relativePath, kind, opened: true }
  }

  private async assertOpenTargetIsFile(
    filePath: string,
    target: { executionHostId: ExecutionHostId }
  ): Promise<void> {
    let stats: FileStat
    try {
      stats = await requireRuntimeFileProvider(target, this.host).stat(filePath)
    } catch (error) {
      if (isENOENT(error)) {
        throw new Error(`ENOENT: no such file or directory, open '${filePath}'`)
      }
      throw error
    }
    if (stats.type === 'directory') {
      throw new Error(`EISDIR: illegal operation on a directory, open '${filePath}'`)
    }
  }

  async openMobileDiff(
    worktreeSelector: string,
    relativePath: string,
    staged: boolean,
    navigation?: RuntimeNavigationTarget,
    oldPath?: string
  ): Promise<RuntimeFileOpenResult> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    if (oldPath !== undefined && !isSafeMobileRelativePath(oldPath)) {
      throw new Error('invalid_relative_path')
    }
    const kind = isMobileBinaryPath(relativePath)
      ? 'binary'
      : isMobileMarkdownPath(relativePath)
        ? 'markdown'
        : 'text'
    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    this.host.openDiff(
      worktree.id,
      filePath,
      relativePath,
      staged,
      runtimeOwnerForTarget(target),
      navigation,
      ...(oldPath ? ([oldPath] as const) : [])
    )
    return { worktree: worktree.id, relativePath, kind, opened: true }
  }

  async listRuntimeMarkdownDocuments(worktreeSelector: string): Promise<MarkdownDocument[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    return listFilesystemMarkdownDocuments(
      requireRuntimeFileProvider(target, this.host),
      target.worktree.path
    )
  }

  async pathsExistRuntimeFiles(
    worktreeSelector: string,
    relativePaths: string[]
  ): Promise<PathExistenceResult[]> {
    validatePathExistenceBatch(relativePaths)
    const targets = await resolveFileExplorerPaths(this.host, worktreeSelector, relativePaths)
    // Link checks on render and retry timers: never start a stopped WSL distro (E9).
    if (targets[0]) {
      await assertRuntimeReadWslDistroRunning(targets[0])
    }
    return readRuntimeFilePathExistence(targets, this.host)
  }

  /** Stat of many workspace paths in one call (cloud file sync manifests). */
  async statManyRuntimeFiles(
    worktreeSelector: string,
    relativePaths: string[]
  ): Promise<FileStatManyResult> {
    if (!Array.isArray(relativePaths) || relativePaths.length > FILE_STAT_MANY_MAX) {
      throw new Error('Invalid stat batch')
    }
    const targets = await resolveFileExplorerPaths(this.host, worktreeSelector, relativePaths)
    if (targets.length === 0) {
      return { entries: [] }
    }
    await assertRuntimeReadWslDistroRunning(targets[0])
    const provider = requireRuntimeFileProvider(targets[0], this.host)
    // Links are followed like every files.* read; one pointing outside the workspace fails the
    // later chunk read's containment check, so it is never copied.
    const statOne = provider.stat.bind(provider)
    const entries: FileStatManyEntry[] = Array.from({ length: targets.length }, () => null)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < targets.length) {
        const index = next++
        try {
          const stats = await statOne(targets[index].path)
          entries[index] = {
            size: stats.size,
            mtime: stats.mtimeMs ?? stats.mtime,
            type: stats.type
          }
        } catch (error) {
          entries[index] = isPathAbsentError(error)
            ? null
            : { error: error instanceof Error ? error.message.slice(0, 200) : 'stat_failed' }
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(STAT_MANY_CONCURRENCY, targets.length) }, worker)
    )
    return { entries }
  }

  async statRuntimeFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<{ size: number; isDirectory: boolean; mtime: number; ctime?: number }> {
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
    const fileStat = await requireRuntimeFileProvider(target, this.host).stat(target.path)
    return {
      size: fileStat.size,
      isDirectory: fileStat.type === 'directory',
      mtime: fileStat.mtime,
      ...(fileStat.ctimeMs === undefined ? {} : { ctime: fileStat.ctimeMs })
    }
  }
}

function runtimeOwnerForTarget(target: { executionHostId: ExecutionHostId }): string | null {
  const host = parseExecutionHostId(target.executionHostId)
  return host?.kind === 'runtime' ? host.environmentId : null
}
