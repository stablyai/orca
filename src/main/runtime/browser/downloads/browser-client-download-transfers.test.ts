import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY,
  BrowserClientDownloadTransferStore,
  type BrowserClientDownloadTransferDependencies
} from './browser-client-download-transfers'

function createStore(
  overrides: Partial<BrowserClientDownloadTransferDependencies> = {},
  maxActiveTransfers?: number
) {
  const written: { relativePath: string; contentBase64: string; append: boolean }[] = []
  const removed: string[] = []
  const committed: { tempRelativePath: string; finalRelativePath: string }[] = []
  const existing = new Set<string>()
  const dependencies: BrowserClientDownloadTransferDependencies = {
    prepareDirectory: async () => ({ expectedExecutionHostId: 'local' }),
    writeChunk: async ({ relativePath, contentBase64, append }) => {
      written.push({ relativePath, contentBase64, append })
    },
    commit: async ({ tempRelativePath, finalRelativePath }) => {
      committed.push({ tempRelativePath, finalRelativePath })
    },
    remove: async ({ relativePath }) => {
      removed.push(relativePath)
    },
    exists: async ({ relativePath }) => existing.has(relativePath),
    ...overrides
  }
  return {
    store: new BrowserClientDownloadTransferStore(dependencies, maxActiveTransfers),
    written,
    removed,
    committed,
    existing
  }
}

const base = {
  transferId: 'transfer-1',
  browserPageId: 'page-1',
  pageHostGeneration: 2,
  workspaceId: 'workspace-1',
  filename: 'report.pdf',
  platform: 'linux' as NodeJS.Platform
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserClientDownloadTransferStore', () => {
  it('strips path separators from a remote-supplied filename', async () => {
    const { store } = createStore()

    const commit = await store.accept({
      ...base,
      filename: '../../etc/passwd',
      contentBase64: '',
      offset: 0,
      final: true
    })

    expect(commit).toEqual({
      workspaceRelativePath: `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/passwd`
    })
  })

  it('drops the partial file when a chunk arrives out of order', async () => {
    const { store, removed } = createStore()
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })

    await expect(
      store.accept({ ...base, contentBase64: 'AAA=', offset: 99, final: false })
    ).rejects.toThrow('browser_client_download_transfer_out_of_order')
    expect(removed).toHaveLength(1)
    expect(store.activeTransferCount()).toBe(0)
  })

  it('releases only the named generation of a page', async () => {
    const { store } = createStore()
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })
    const replacement = { ...base, transferId: 'transfer-2', pageHostGeneration: 3 }
    await store.accept({ ...replacement, contentBase64: 'AAA=', offset: 0, final: false })

    await store.releasePage(base.browserPageId, base.pageHostGeneration)

    expect(store.activeTransferCount()).toBe(1)
    await expect(
      store.accept({ ...replacement, contentBase64: '', offset: 2, final: false })
    ).resolves.not.toThrow()
  })

  it('rejects a transfer resumed under a replaced page generation', async () => {
    const { store } = createStore()
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })

    await expect(
      store.accept({
        ...base,
        pageHostGeneration: 9,
        contentBase64: 'AAA=',
        offset: 2,
        final: false
      })
    ).rejects.toThrow('browser_client_download_transfer_stale')
  })

  it('does not recreate the partial file when an abort lands mid-write', async () => {
    let releaseWrite = (): void => {}
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const written: string[] = []
    const removed: string[] = []
    const committed: string[] = []
    const { store } = createStore({
      writeChunk: async ({ relativePath }) => {
        written.push(relativePath)
        await pendingWrite
      },
      remove: async ({ relativePath }) => {
        removed.push(relativePath)
      },
      commit: async ({ finalRelativePath }) => {
        committed.push(finalRelativePath)
      }
    })

    const accepting = store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: true })
    void accepting.catch(() => undefined)
    await vi.waitFor(() => expect(written).toHaveLength(1))
    const aborting = store.abort({ transferId: base.transferId, browserPageId: base.browserPageId })
    releaseWrite()

    await expect(accepting).rejects.toThrow('browser_client_download_transfer_aborted')
    expect(await aborting).toBe(true)
    expect(committed).toEqual([])
    expect(removed).toHaveLength(1)
    expect(store.activeTransferCount()).toBe(0)
    expect(written).toHaveLength(1)
  })

  it('rejects a chunk that arrives after the page released its transfers', async () => {
    const { store, committed } = createStore()
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })

    await store.releasePage(base.browserPageId)

    await expect(
      store.accept({ ...base, contentBase64: 'AAA=', offset: 3, final: true })
    ).rejects.toThrow('browser_client_download_transfer_settled')
    expect(committed).toEqual([])
  })
})
