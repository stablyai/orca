import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { RuntimeFileCommandHost } from '../../files/file-command-host'
import type { ResolvedRuntimeFileTarget } from '../../files/file-target'
import { RuntimeFileMutations } from '../../files/file-mutations'
import { getBrowserClientDownloadTransferStore } from './browser-client-download-transfer-store'

vi.mock('../../files/chat-scratch-file-root', () => ({
  resolveRuntimeAuthorizedPath: async (path: string) => path
}))

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-browser-download-store-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function serverRuntime() {
  const host: Pick<RuntimeFileCommandHost, 'requireStore' | 'resolveRuntimeFileTarget'> = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store only reaches the mocked path authorization.
    requireStore: () => ({}) as RuntimeStore,
    resolveRuntimeFileTarget: async () => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mutations use only the worktree's path.
      worktree: { id: 'wt-1', path: root } as ResolvedRuntimeFileTarget['worktree'],
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
  }
  const mutations = new RuntimeFileMutations(host)
  return {
    resolveRuntimeFileTarget: host.resolveRuntimeFileTarget,
    writeFileExplorerFileBase64Chunk: mutations.writeFileExplorerFileBase64Chunk.bind(mutations),
    commitFileExplorerUpload: mutations.commitFileExplorerUpload.bind(mutations),
    deleteFileExplorerPath: mutations.deleteFileExplorerPath.bind(mutations),
    statRuntimeFile: (_worktree: string, relativePath: string) => stat(join(root, relativePath))
  }
}

describe('browser downloads into a server workspace', () => {
  // #45838: the second download failed once .orca/browser-downloads existed.
  it('saves consecutive downloads into the same workspace directory', async () => {
    const store = getBrowserClientDownloadTransferStore(serverRuntime())
    const download = (transferId: string, filename: string, content: string) =>
      store.accept({
        transferId,
        browserPageId: 'page-1',
        pageHostGeneration: 1,
        workspaceId: 'id:wt-1',
        filename,
        contentBase64: Buffer.from(content).toString('base64'),
        offset: 0,
        final: true,
        platform: process.platform
      })

    await expect(download('t-1', 'first.txt', 'one')).resolves.toEqual({
      workspaceRelativePath: '.orca/browser-downloads/first.txt'
    })
    await expect(download('t-2', 'second.txt', 'two')).resolves.toEqual({
      workspaceRelativePath: '.orca/browser-downloads/second.txt'
    })
    expect(readFileSync(join(root, '.orca/browser-downloads/second.txt'), 'utf8')).toBe('two')
  })
})
