// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithWriteFileExplorerFile } from './runtime-file-commands-write-file-explorer-file'
import { assertRuntimeFileMutationExpectation } from './runtime-file-commands-mobile-file-list-limit'
import {
  requireRuntimeFileProvider,
  requireSshRuntimeFileProvider,
  runtimeFileRouteForTarget
} from './runtime-file-command-target'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { constants, copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export class RuntimeFileCommandsWithCreateFileExplorerDirNoClobber extends RuntimeFileCommandsWithWriteFileExplorerFile {
  async createFileExplorerDirNoClobber(
    worktreeSelector: string,
    relativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    await requireRuntimeFileProvider(target, this.host).createDirNoClobber(target.path)
    return { ok: true }
  }

  async commitFileExplorerUpload(
    worktreeSelector: string,
    tempRelativePath: string,
    finalRelativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const [tempTarget, finalTarget] = await this.resolveFileExplorerPaths(worktreeSelector, [
      tempRelativePath,
      finalRelativePath
    ])
    assertRuntimeFileMutationExpectation(
      tempTarget.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const route = runtimeFileRouteForTarget(tempTarget)
    // Why: the local arm commits through the resolved (not symlink-preserving) temp and final paths.
    if (route.kind === 'ssh') {
      const provider = requireSshRuntimeFileProvider(route)
      await provider.copy(tempTarget.path, finalTarget.path)
      await provider.deletePath(tempTarget.path, false).catch(() => {})
      return { ok: true }
    }

    const store = this.host.requireStore()
    const tempPath = await resolveAuthorizedPath(tempTarget.path, store)
    const finalPath = await resolveAuthorizedPath(finalTarget.path, store)
    await mkdir(dirname(finalPath), { recursive: true })
    await copyFile(tempPath, finalPath, constants.COPYFILE_EXCL)
    await rm(tempPath, { force: true })
    return { ok: true }
  }

  async renameFileExplorerPath(
    worktreeSelector: string,
    oldRelativePath: string,
    newRelativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const [oldTarget, newTarget] = await this.resolveFileExplorerPaths(worktreeSelector, [
      oldRelativePath,
      newRelativePath
    ])
    assertRuntimeFileMutationExpectation(
      oldTarget.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    await requireRuntimeFileProvider(oldTarget, this.host).renameNoClobber(
      oldTarget.path,
      newTarget.path
    )
    return { ok: true }
  }

  async copyFileExplorerPath(
    worktreeSelector: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const [sourceTarget, destinationTarget] = await this.resolveFileExplorerPaths(
      worktreeSelector,
      [sourceRelativePath, destinationRelativePath]
    )
    assertRuntimeFileMutationExpectation(
      sourceTarget.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    await requireRuntimeFileProvider(sourceTarget, this.host).copy(
      sourceTarget.path,
      destinationTarget.path
    )
    return { ok: true }
  }

  async deleteFileExplorerPath(
    worktreeSelector: string,
    relativePath: string,
    recursive?: boolean,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    // Why: a non-local runtime has no client Trash; this delete is permanent, so the renderer confirms before calling.
    await requireRuntimeFileProvider(target, this.host).deletePath(target.path, recursive)
    return { ok: true }
  }
}
