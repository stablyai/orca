import type * as Crypto from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { RuntimeFileCommandHost } from '../../files/file-command-host'
import type { ResolvedRuntimeFileTarget } from '../../files/file-target'
import { RuntimeFileMutations } from '../../files/file-mutations'
import { getBrowserClientDownloadTransferStore } from './browser-client-download-transfer-store'

const { randomUUID } = vi.hoisted(() => ({ randomUUID: vi.fn<() => string>() }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>()
  randomUUID.mockImplementation(actual.randomUUID)
  return { ...actual, randomUUID }
})

let root: string
// Authorization is store-backed; confine writes to the test workspace instead.
vi.mock('../../files/chat-scratch-file-root', () => ({
  resolveRuntimeAuthorizedPath: async (path: string) => {
    const fromRoot = relative(root, path)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new Error('outside workspace')
    }
    return path
  }
}))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-browser-download-store-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const downloadsDir = () => join(root, '.orca/browser-downloads')

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
    writeFileExplorerFileBase64Chunk: vi.fn(
      mutations.writeFileExplorerFileBase64Chunk.bind(mutations)
    ),
    commitFileExplorerUpload: mutations.commitFileExplorerUpload.bind(mutations),
    deleteFileExplorerPath: mutations.deleteFileExplorerPath.bind(mutations),
    createFileExplorerDir: mutations.createFileExplorerDir.bind(mutations),
    statRuntimeFile: (_worktree: string, relativePath: string) => stat(join(root, relativePath))
  }
}

function chunk(transferId: string, content: string, offset = 0, final = true) {
  return {
    transferId,
    browserPageId: 'page-1',
    pageHostGeneration: 1,
    workspaceId: 'id:wt-1',
    filename: 'file.txt',
    contentBase64: Buffer.from(content).toString('base64'),
    offset,
    final,
    platform: process.platform
  }
}

describe('browser downloads into a server workspace', () => {
  // #45838: the second download failed once .orca/browser-downloads existed.
  it('saves consecutive downloads into the same workspace directory', async () => {
    const store = getBrowserClientDownloadTransferStore(serverRuntime())

    await expect(store.accept({ ...chunk('t-1', 'one'), filename: 'first.txt' })).resolves.toEqual({
      workspaceRelativePath: '.orca/browser-downloads/first.txt'
    })
    await expect(store.accept({ ...chunk('t-2', 'two'), filename: 'second.txt' })).resolves.toEqual(
      { workspaceRelativePath: '.orca/browser-downloads/second.txt' }
    )
    expect(readFileSync(join(downloadsDir(), 'second.txt'), 'utf8')).toBe('two')
  })

  // #45892: a failed exclusive first write must not delete a file the transfer did not create.
  it('keeps an existing file when the first write cannot create the staging file', async () => {
    mkdirSync(downloadsDir(), { recursive: true })
    writeFileSync(join(downloadsDir(), '.incoming-taken'), 'keep')
    randomUUID.mockReturnValueOnce('taken')
    const store = getBrowserClientDownloadTransferStore(serverRuntime())

    await expect(store.accept(chunk('taken', 'new'))).rejects.toThrow()
    expect(readFileSync(join(downloadsDir(), '.incoming-taken'), 'utf8')).toBe('keep')
  })

  it('removes its own partial file when a later chunk write fails', async () => {
    const runtime = serverRuntime()
    const store = getBrowserClientDownloadTransferStore(runtime)
    await expect(store.accept(chunk('t-1', 'part', 0, false))).resolves.toBeNull()
    expect(readdirSync(downloadsDir())).toHaveLength(1)

    runtime.writeFileExplorerFileBase64Chunk.mockRejectedValueOnce(new Error('disk full'))
    await expect(store.accept(chunk('t-1', 'rest', 4))).rejects.toThrow('disk full')
    expect(readdirSync(downloadsDir())).toEqual([])
  })
})
