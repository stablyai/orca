import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BROWSER_CLIENT_DOWNLOAD_TRANSFER_IDLE_TIMEOUT_MS,
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
    writeChunk: async ({ relativePath, contentBase64, append }) => {
      written.push({ relativePath, contentBase64, append })
    },
    commit: async ({ tempRelativePath, finalRelativePath }) => {
      committed.push({ tempRelativePath, finalRelativePath })
    },
    remove: async ({ relativePath }) => {
      removed.push(relativePath)
    },
    ensureDirectory: async () => {},
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
  it('appends sequential chunks and commits into the workspace downloads directory', async () => {
    const { store, written, committed } = createStore()

    expect(
      await store.accept({
        ...base,
        contentBase64: Buffer.from('one').toString('base64'),
        offset: 0,
        final: false
      })
    ).toBeNull()
    const commit = await store.accept({
      ...base,
      contentBase64: Buffer.from('two').toString('base64'),
      offset: 3,
      final: true
    })

    expect(written.map((chunk) => chunk.append)).toEqual([false, true])
    expect(commit).toEqual({
      workspaceRelativePath: `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/report.pdf`
    })
    expect(committed).toHaveLength(1)
    expect(committed[0].tempRelativePath).toContain('.incoming-transfer-1')
    expect(store.activeTransferCount()).toBe(0)
  })

  it('picks a collision-free name on the remote', async () => {
    const { store, existing } = createStore()
    existing.add(`${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/report.pdf`)

    const commit = await store.accept({ ...base, contentBase64: '', offset: 0, final: true })

    expect(commit).toEqual({
      workspaceRelativePath: `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/report (1).pdf`
    })
  })

  it('takes the next candidate when a concurrent transfer wins the destination name', async () => {
    const attempted: string[] = []
    const { store, removed } = createStore({
      commit: async ({ finalRelativePath }) => {
        attempted.push(finalRelativePath)
        if (attempted.length === 1) {
          throw Object.assign(new Error('EEXIST: file already exists, copyfile'), {
            code: 'EEXIST'
          })
        }
      }
    })

    const commit = await store.accept({ ...base, contentBase64: '', offset: 0, final: true })

    expect(attempted).toEqual([
      `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/report.pdf`,
      `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/report (1).pdf`
    ])
    expect(commit).toEqual({
      workspaceRelativePath: `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/report (1).pdf`
    })
    // Why: the loser's fully transferred bytes must survive the retry, not be released.
    expect(removed).toEqual([])
  })

  it('retries the relay collision rejection, which carries no errno code', async () => {
    const attempted: string[] = []
    const { store } = createStore({
      commit: async ({ finalRelativePath }) => {
        attempted.push(finalRelativePath)
        if (attempted.length === 1) {
          throw new Error('EEXIST: destination already exists')
        }
      }
    })

    expect(await store.accept({ ...base, contentBase64: '', offset: 0, final: true })).toEqual({
      workspaceRelativePath: `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/report (1).pdf`
    })
    expect(attempted).toHaveLength(2)
  })

  it('drops the transfer when the commit fails for a reason other than a collision', async () => {
    const { store, removed } = createStore({
      commit: async () => {
        throw new Error('EACCES: permission denied')
      }
    })

    await expect(
      store.accept({ ...base, contentBase64: '', offset: 0, final: true })
    ).rejects.toThrow('EACCES')
    expect(removed).toHaveLength(1)
    expect(store.activeTransferCount()).toBe(0)
  })

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

  it('drops the partial file when the remote write fails', async () => {
    const removed: string[] = []
    const { store } = createStore({
      writeChunk: async () => {
        throw new Error('remote disk full')
      },
      remove: async ({ relativePath }) => {
        removed.push(relativePath)
      }
    })

    await expect(
      store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })
    ).rejects.toThrow('remote disk full')
    expect(removed).toHaveLength(1)
    expect(store.activeTransferCount()).toBe(0)
  })

  it('releases every transfer owned by a closed page', async () => {
    const { store, removed } = createStore()
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })
    await store.accept({
      ...base,
      transferId: 'transfer-2',
      contentBase64: 'AAA=',
      offset: 0,
      final: false
    })
    await store.accept({
      ...base,
      browserPageId: 'page-2',
      transferId: 'transfer-3',
      contentBase64: 'AAA=',
      offset: 0,
      final: false
    })

    await store.releasePage('page-1')

    expect(removed).toHaveLength(2)
    expect(store.activeTransferCount()).toBe(1)
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

  it('bounds concurrent transfers', async () => {
    const dependencies = {
      writeChunk: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      ensureDirectory: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(false)
    }
    const store = new BrowserClientDownloadTransferStore(dependencies, 1)
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })

    await expect(
      store.accept({
        ...base,
        transferId: 'transfer-2',
        contentBase64: 'AAA=',
        offset: 0,
        final: false
      })
    ).rejects.toThrow('browser_client_download_transfer_capacity')
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

  it('rejects a chunk that arrives after the transfer was aborted', async () => {
    const { store, written, removed } = createStore()
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })

    expect(
      await store.abort({ transferId: base.transferId, browserPageId: base.browserPageId })
    ).toBe(true)
    expect(removed).toHaveLength(1)

    await expect(
      store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })
    ).rejects.toThrow('browser_client_download_transfer_settled')
    expect(written).toHaveLength(1)
    expect(store.activeTransferCount()).toBe(0)
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

  it('retires an idle transfer and hands its slot to the next download', async () => {
    vi.useFakeTimers()
    const { store, removed } = createStore({}, 1)
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })
    expect(store.activeTransferCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(BROWSER_CLIENT_DOWNLOAD_TRANSFER_IDLE_TIMEOUT_MS)

    expect(removed).toEqual([`${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/.incoming-transfer-1`])
    expect(store.activeTransferCount()).toBe(0)
    expect(
      await store.accept({
        ...base,
        transferId: 'transfer-2',
        contentBase64: '',
        offset: 0,
        final: true
      })
    ).toEqual({
      workspaceRelativePath: `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/report.pdf`
    })
  })

  it('never expires a transfer whose chunk is still in flight', async () => {
    vi.useFakeTimers()
    let releaseWrite = (): void => {}
    const stalledWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let writes = 0
    const { store, removed } = createStore({
      writeChunk: async () => {
        writes += 1
        if (writes > 1) {
          await stalledWrite
        }
      }
    })
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })

    const accepting = store.accept({ ...base, contentBase64: 'AAA=', offset: 2, final: false })
    await vi.advanceTimersByTimeAsync(BROWSER_CLIENT_DOWNLOAD_TRANSFER_IDLE_TIMEOUT_MS * 2)
    releaseWrite()

    expect(await accepting).toBeNull()
    expect(removed).toEqual([])
    expect(store.activeTransferCount()).toBe(1)
  })

  it('restarts the idle deadline on every chunk', async () => {
    vi.useFakeTimers()
    const { store, removed } = createStore()
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })

    await vi.advanceTimersByTimeAsync(BROWSER_CLIENT_DOWNLOAD_TRANSFER_IDLE_TIMEOUT_MS - 1)
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 2, final: false })
    await vi.advanceTimersByTimeAsync(BROWSER_CLIENT_DOWNLOAD_TRANSFER_IDLE_TIMEOUT_MS - 1)

    expect(removed).toEqual([])
    expect(store.activeTransferCount()).toBe(1)
  })

  it('frees the slot a released page was holding', async () => {
    const { store } = createStore({}, 1)
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })

    await store.releasePage(base.browserPageId)

    expect(store.activeTransferCount()).toBe(0)
    expect(
      await store.accept({
        ...base,
        transferId: 'transfer-2',
        contentBase64: '',
        offset: 0,
        final: true
      })
    ).toEqual({
      workspaceRelativePath: `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/report.pdf`
    })
  })

  it('rejects malformed base64 instead of silently truncating the file', async () => {
    const { store } = createStore()

    await expect(
      store.accept({ ...base, contentBase64: 'AA*A', offset: 0, final: false })
    ).rejects.toThrow('browser_client_file_channel_chunk_invalid')
  })
})
