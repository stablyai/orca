// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithWriteFileExplorerFile } from './runtime-file-commands-write-file-explorer-file'
import { assertRuntimeFileMutationExpectation } from './runtime-file-commands-mobile-file-list-limit'
import { requireRuntimeFileProvider } from './runtime-file-command-target'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { constants, copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameLocalPathSerializedByDestination } from '../destination-serialized-local-rename'

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
    const provider = requireRuntimeFileProvider(target)
    if (provider) {
      await provider.createDirNoClobber(target.path)
      return { ok: true }
    }

    const dirPath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    await mkdir(dirPath, { recursive: false })
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
    const provider = requireRuntimeFileProvider(tempTarget)
    if (provider) {
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
    const provider = requireRuntimeFileProvider(oldTarget)
    if (provider) {
      await provider.renameNoClobber(oldTarget.path, newTarget.path)
      return { ok: true }
    }

    const store = this.host.requireStore()
    const oldPath = await resolveAuthorizedPath(oldTarget.path, store, { preserveSymlink: true })
    const newPath = await resolveAuthorizedPath(newTarget.path, store, { preserveSymlink: true })
    await renameLocalPathSerializedByDestination(oldPath, newPath)
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
    const provider = requireRuntimeFileProvider(sourceTarget)
    if (provider) {
      await provider.copy(sourceTarget.path, destinationTarget.path)
      return { ok: true }
    }

    const store = this.host.requireStore()
    const sourcePath = await resolveAuthorizedPath(sourceTarget.path, store, {
      preserveSymlink: true
    })
    const destinationPath = await resolveAuthorizedPath(destinationTarget.path, store, {
      preserveSymlink: true
    })
    await mkdir(dirname(destinationPath), { recursive: true })
    // Why: COPYFILE_EXCL preserves the no-clobber invariant of the local shell copy IPC (caller already deconflicts names).
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL)
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
    const provider = requireRuntimeFileProvider(target)
    if (provider) {
      await provider.deletePath(target.path, recursive)
      return { ok: true }
    }

    const targetPath = await resolveAuthorizedPath(target.path, this.host.requireStore(), {
      preserveSymlink: true
    })
    // Why: a non-local runtime has no client Trash; this delete is permanent, so the renderer confirms before calling.
    await rm(targetPath, { recursive: recursive === true, force: true })
    return { ok: true }
  }
}
