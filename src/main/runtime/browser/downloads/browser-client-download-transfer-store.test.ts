import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { ResolvedRuntimeFileTarget } from '../../files/file-target'
import { RuntimeFileMutations } from '../../files/file-mutations'
import { getBrowserClientDownloadTransferStore } from './browser-client-download-transfer-store'

// The real authorization follows links to the file they name; mirror that without a store.
vi.mock('../../files/chat-scratch-file-root', () => ({
  resolveRuntimeAuthorizedPath: async (path: string) => realpath(path).catch(() => path)
}))

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-browser-download-store-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function serverRuntime() {
  const resolveRuntimeFileTarget = async () => ({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: file mutations use only the worktree's id and path.
    worktree: { id: 'wt-1', path: root } as ResolvedRuntimeFileTarget['worktree'],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a host id the route reads.
    executionHostId: 'local' as ResolvedRuntimeFileTarget['executionHostId']
  })
  const mutations = new RuntimeFileMutations({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store only reaches the mocked path authorization.
    requireStore: () => ({}) as RuntimeStore,
    resolveRuntimeFileTarget
  })
  return {
    resolveRuntimeFileTarget,
    writeFileExplorerFileBase64Chunk: mutations.writeFileExplorerFileBase64Chunk.bind(mutations),
    commitFileExplorerUpload: mutations.commitFileExplorerUpload.bind(mutations),
    deleteFileExplorerPath: mutations.deleteFileExplorerPath.bind(mutations),
    createFileExplorerDir: mutations.createFileExplorerDir.bind(mutations),
    statRuntimeFile: (_worktree: string, relativePath: string) => stat(join(root, relativePath))
  }
}

function download(transferId: string, contents: string) {
  return {
    transferId,
    browserPageId: 'page-1',
    pageHostGeneration: 1,
    workspaceId: 'wt-1',
    filename: 'client_secret.json',
    contentBase64: Buffer.from(contents).toString('base64'),
    offset: 0,
    final: true,
    platform: process.platform
  }
}

describe('browser downloads into a server workspace', () => {
  it('saves consecutive downloads into a workspace that has no .orca folder yet', async () => {
    const store = getBrowserClientDownloadTransferStore(serverRuntime())

    await expect(store.accept(download('transfer-1', 'first'))).resolves.toEqual({
      workspaceRelativePath: '.orca/browser-downloads/client_secret.json'
    })
    await expect(store.accept(download('transfer-2', 'second'))).resolves.toEqual({
      workspaceRelativePath: '.orca/browser-downloads/client_secret (1).json'
    })
    expect(
      readFileSync(join(root, '.orca', 'browser-downloads', 'client_secret.json'), 'utf8')
    ).toBe('first')
    expect(
      readFileSync(join(root, '.orca', 'browser-downloads', 'client_secret (1).json'), 'utf8')
    ).toBe('second')
  })
})
