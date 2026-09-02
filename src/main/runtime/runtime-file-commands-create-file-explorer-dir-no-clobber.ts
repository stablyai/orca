// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithWriteFileExplorerFile } from './runtime-file-commands-write-file-explorer-file'
import { assertRuntimeFileMutationExpectation } from './runtime-file-commands-mobile-file-list-limit'
import {
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE,
  getSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import {
  assertMutableRemotePath,
  resolveAuthorizedMutablePath
} from './repository-admin-path-authorization'
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
    const target = await this.resolveFileExplorerMutationPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await assertMutableRemotePath(provider, target.path, target.worktree.path, {
        followsLink: false
      })
      await provider.createDirNoClobber(target.path)
      return { ok: true }
    }

    const dirPath = await resolveAuthorizedMutablePath(target.path, this.host.requireStore())
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
    const [tempTarget, finalTarget] = await this.resolveFileExplorerMutationPaths(
      worktreeSelector,
      [tempRelativePath, finalRelativePath]
    )
    assertRuntimeFileMutationExpectation(
      tempTarget.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = tempTarget.connectionId
      ? getSshFilesystemProvider(tempTarget.connectionId)
      : null
    if (tempTarget.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await assertMutableRemotePath(provider, tempTarget.path, tempTarget.worktree.path, {
        followsLink: true
      })
      await assertMutableRemotePath(provider, finalTarget.path, finalTarget.worktree.path, {
        followsLink: false
      })
      await provider.copy(tempTarget.path, finalTarget.path)
      await provider.deletePath(tempTarget.path, false).catch(() => {})
      return { ok: true }
    }

    const store = this.host.requireStore()
    // Why followsLink on temp only: copyFile reads through it, while COPYFILE_EXCL means the
    // destination must not exist, so there is no inode there to alias.
    const tempPath = await resolveAuthorizedMutablePath(tempTarget.path, store, {
      followsLink: true
    })
    const finalPath = await resolveAuthorizedMutablePath(finalTarget.path, store)
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
    const [oldTarget, newTarget] = await this.resolveFileExplorerMutationPaths(worktreeSelector, [
      oldRelativePath,
      newRelativePath
    ])
    assertRuntimeFileMutationExpectation(
      oldTarget.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = oldTarget.connectionId
      ? getSshFilesystemProvider(oldTarget.connectionId)
      : null
    if (oldTarget.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await assertMutableRemotePath(provider, oldTarget.path, oldTarget.worktree.path, {
        followsLink: false
      })
      await assertMutableRemotePath(provider, newTarget.path, newTarget.worktree.path, {
        followsLink: false
      })
      await provider.renameNoClobber(oldTarget.path, newTarget.path)
      return { ok: true }
    }

    const store = this.host.requireStore()
    const oldPath = await resolveAuthorizedMutablePath(oldTarget.path, store, {
      preserveSymlink: true
    })
    const newPath = await resolveAuthorizedMutablePath(newTarget.path, store, {
      preserveSymlink: true
    })
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
    const [sourceTarget, destinationTarget] = await this.resolveFileExplorerMutationPaths(
      worktreeSelector,
      [sourceRelativePath, destinationRelativePath]
    )
    assertRuntimeFileMutationExpectation(
      sourceTarget.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = sourceTarget.connectionId
      ? getSshFilesystemProvider(sourceTarget.connectionId)
      : null
    if (sourceTarget.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await assertMutableRemotePath(provider, sourceTarget.path, sourceTarget.worktree.path, {
        followsLink: true
      })
      await assertMutableRemotePath(
        provider,
        destinationTarget.path,
        destinationTarget.worktree.path,
        {
          followsLink: true
        }
      )
      await provider.copy(sourceTarget.path, destinationTarget.path)
      return { ok: true }
    }

    const store = this.host.requireStore()
    // Why followsLink: copyFile reads and writes *through* a leaf symlink, so the link's target is
    // the object it touches — unlike rename/delete, which act on the entry itself.
    const sourcePath = await resolveAuthorizedMutablePath(sourceTarget.path, store, {
      preserveSymlink: true,
      followsLink: true
    })
    const destinationPath = await resolveAuthorizedMutablePath(destinationTarget.path, store, {
      preserveSymlink: true,
      followsLink: true
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
    const target = await this.resolveFileExplorerMutationPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await assertMutableRemotePath(provider, target.path, target.worktree.path, {
        followsLink: false
      })
      await provider.deletePath(target.path, recursive)
      return { ok: true }
    }

    const targetPath = await resolveAuthorizedMutablePath(target.path, this.host.requireStore(), {
      preserveSymlink: true
    })
    // Why: a non-local runtime has no client Trash; this delete is permanent, so the renderer confirms before calling.
    await rm(targetPath, { recursive: recursive === true, force: true })
    return { ok: true }
  }
}
