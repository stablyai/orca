import type { RuntimeFileOpenPosition } from '../../../shared/runtime-file-contracts'
import { listFilesystemMarkdownDocuments } from '../../providers/filesystem-markdown-listing'
import type { MarkdownDocument } from '../../../shared/filesystem-entry-types'
import {
  validatePathExistenceBatch,
  type PathExistenceResult
} from '../../../shared/path-existence-batch'
import { readRuntimeFilePathExistence } from './file-path-existence'
import {
  isMobileBinaryPath,
  isMobileMarkdownPath,
  isSafeMobileRelativePath,
  isMobilePreviewableImagePath
} from './mobile-file-kind'
import type { RuntimeFileCommandHost } from './file-command-host'
import type { RuntimeFileOpenResult } from '../../../shared/runtime-types'
import type { RuntimeNavigationTarget } from '../../../shared/runtime-navigation'
import { joinWorktreeRelativePath } from '../runtime-relative-paths'
import { isENOENT } from '../../ipc/filesystem/filesystem-path-containment'
import {
  requireRuntimeFileProvider,
  resolveFileExplorerPath,
  resolveFileExplorerPaths
} from './file-target'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { FileStat } from '../../providers/filesystem-provider-contract'
import { assertRuntimeReadWslDistroRunning } from '../runtime-wsl-background-read-gate'

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
    navigation?: RuntimeNavigationTarget
  ): Promise<RuntimeFileOpenResult> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    if (!isSafeMobileRelativePath(relativePath)) {
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
      navigation
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
