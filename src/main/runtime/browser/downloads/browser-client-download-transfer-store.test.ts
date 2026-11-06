import { describe, expect, it } from 'vitest'

import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getBrowserClientDownloadTransferStore } from './browser-client-download-transfer-store'
import { assertRuntimeFileMutationExpectation } from '../../files/file-mutation-expectation'

// Mutations enforce the same host expectation RuntimeFileMutations does.
function createServerRuntime(executionHostId: ExecutionHostId) {
  const files = new Map<string, string>()
  const guard = (generation?: number, sshTargetId?: string, hostId?: string): void =>
    assertRuntimeFileMutationExpectation(executionHostId, hostId, sshTargetId, generation)
  const runtime = {
    resolveRuntimeFileTarget: async () => ({ executionHostId }),
    createFileExplorerDir: async (
      _worktree: string,
      _relativePath: string,
      ...expectation: [number?, string?, string?]
    ) => guard(...expectation),
    writeFileExplorerFileBase64Chunk: async (
      _worktree: string,
      relativePath: string,
      contentBase64: string,
      append: boolean,
      ...expectation: [number?, string?, string?]
    ) => {
      guard(...expectation)
      files.set(relativePath, (append ? (files.get(relativePath) ?? '') : '') + contentBase64)
    },
    commitFileExplorerUpload: async (
      _worktree: string,
      tempRelativePath: string,
      finalRelativePath: string,
      ...expectation: [number?, string?, string?]
    ) => {
      guard(...expectation)
      files.set(finalRelativePath, files.get(tempRelativePath) ?? '')
      files.delete(tempRelativePath)
    },
    deleteFileExplorerPath: async (
      _worktree: string,
      relativePath: string,
      _recursive: boolean,
      ...expectation: [number?, string?, string?]
    ) => {
      guard(...expectation)
      files.delete(relativePath)
    },
    statRuntimeFile: async (_worktree: string, relativePath: string) => {
      if (!files.has(relativePath)) {
        throw new Error('ENOENT')
      }
      return {}
    }
  }
  return { runtime, files }
}

describe('browser client download transfer store', () => {
  it('saves a download into a workspace the server hosts (#38122)', async () => {
    const { runtime, files } = createServerRuntime('local')
    const chunk = {
      transferId: 'transfer-1',
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      workspaceId: 'workspace-1',
      filename: 'photo.png',
      platform: 'linux' as const
    }
    const store = getBrowserClientDownloadTransferStore(runtime)

    await store.accept({ ...chunk, contentBase64: 'AAAA', offset: 0, final: false })
    const commit = await store.accept({ ...chunk, contentBase64: 'BBBB', offset: 3, final: true })

    expect(commit).toEqual({ workspaceRelativePath: '.orca/browser-downloads/photo.png' })
    expect(files.get('.orca/browser-downloads/photo.png')).toBe('AAAABBBB')
  })
})
