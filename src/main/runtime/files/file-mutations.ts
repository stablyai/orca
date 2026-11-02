import { assertRuntimeFileMutationExpectation } from './file-mutation-expectation'
import {
  requireLocalRuntimeFileRoute,
  requireRuntimeFileProvider,
  resolveFileExplorerPath,
  resolveFileExplorerPaths
} from './file-target'
import type { RuntimeFileCommandHost } from './file-command-host'
import { runNativeChatScratchSave } from '../../native-chat/native-chat-scratch-folder-lock'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { resolveRuntimeAuthorizedPath } from './chat-scratch-file-root'
import { constants, copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

type RuntimeFileMutationHost = Pick<
  RuntimeFileCommandHost,
  'requireStore' | 'resolveRuntimeFileTarget'
>

export class RuntimeFileMutations {
  constructor(private readonly host: RuntimeFileMutationHost) {}

  async writeFileExplorerFile(
    worktreeSelector: string,
    relativePath: string,
    content: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    await runNativeChatScratchSave(getProfileUserDataPath(), target.path, () =>
      requireRuntimeFileProvider(target, this.host).writeFile(target.path, content)
    )
    return { ok: true }
  }

  async writeFileExplorerFileBase64(
    worktreeSelector: string,
    relativePath: string,
    contentBase64: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    await runNativeChatScratchSave(getProfileUserDataPath(), target.path, () =>
      requireRuntimeFileProvider(target, this.host).writeFileBase64(target.path, contentBase64)
    )
    return { ok: true }
  }

  async writeFileExplorerFileBase64Chunk(
    worktreeSelector: string,
    relativePath: string,
    contentBase64: string,
    append: boolean,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    await runNativeChatScratchSave(getProfileUserDataPath(), target.path, () =>
      requireRuntimeFileProvider(target, this.host).writeFileBase64Chunk(
        target.path,
        contentBase64,
        append
      )
    )
    return { ok: true }
  }

  async createFileExplorerFile(
    worktreeSelector: string,
    relativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    await requireRuntimeFileProvider(target, this.host).createFile(target.path)
    return { ok: true }
  }

  async createFileExplorerDir(
    worktreeSelector: string,
    relativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    await requireRuntimeFileProvider(target, this.host).createDir(target.path)
    return { ok: true }
  }

  async createFileExplorerDirNoClobber(
    worktreeSelector: string,
    relativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
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
    const [tempTarget, finalTarget] = await resolveFileExplorerPaths(this.host, worktreeSelector, [
      tempRelativePath,
      finalRelativePath
    ])
    assertRuntimeFileMutationExpectation(
      tempTarget.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    requireLocalRuntimeFileRoute(tempTarget)
    // Why: commit through the resolved (not symlink-preserving) temp and final paths.
    const store = this.host.requireStore()
    const tempPath = await resolveRuntimeAuthorizedPath(tempTarget.path, store)
    const finalPath = await resolveRuntimeAuthorizedPath(finalTarget.path, store)
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
    const [oldTarget, newTarget] = await resolveFileExplorerPaths(this.host, worktreeSelector, [
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
    const [sourceTarget, destinationTarget] = await resolveFileExplorerPaths(
      this.host,
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
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
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
