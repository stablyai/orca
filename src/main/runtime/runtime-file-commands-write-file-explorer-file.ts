// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithReadFileExplorerPreview } from './runtime-file-commands-read-file-explorer-preview'
import { assertRuntimeFileMutationExpectation } from './runtime-file-commands-mobile-file-list-limit'
import { requireRuntimeFileProvider } from './runtime-file-command-target'

export class RuntimeFileCommandsWithWriteFileExplorerFile extends RuntimeFileCommandsWithReadFileExplorerPreview {
  async writeFileExplorerFile(
    worktreeSelector: string,
    relativePath: string,
    content: string,
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
    await requireRuntimeFileProvider(target, this.host).writeFile(target.path, content)
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
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    await requireRuntimeFileProvider(target, this.host).writeFileBase64(target.path, contentBase64)
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
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    await requireRuntimeFileProvider(target, this.host).writeFileBase64Chunk(
      target.path,
      contentBase64,
      append
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
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
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
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    await requireRuntimeFileProvider(target, this.host).createDir(target.path)
    return { ok: true }
  }
}
