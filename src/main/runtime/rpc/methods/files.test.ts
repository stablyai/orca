/* eslint-disable max-lines -- Why: file RPC routing coverage stays together so
the dispatcher contract for read, write, mutation, and watch methods is easy to audit. */
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('file RPC methods', () => {
  it('lists files for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileFiles: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        rootPath: '/repo',
        files: [],
        totalCount: 0,
        truncated: false
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(makeRequest('files.list', { worktree: 'id:wt-1' }))

    expect(runtime.listMobileFiles).toHaveBeenCalledWith('id:wt-1')
    expect(response).toMatchObject({
      ok: true,
      result: { worktree: 'wt-1', files: [] }
    })
  })

  it('opens a relative file path for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      openMobileFile: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        relativePath: 'docs/readme.md',
        kind: 'markdown',
        opened: true
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'docs/readme.md' })
    )

    expect(runtime.openMobileFile).toHaveBeenCalledWith('id:wt-1', 'docs/readme.md')
    expect(response).toMatchObject({
      ok: true,
      result: { kind: 'markdown', opened: true }
    })
  })

  it('streams file watch changes until the subscription is cleaned up', async () => {
    vi.useFakeTimers()
    try {
      type WatchCallback = (
        events: { kind: 'update'; absolutePath: string; isDirectory?: boolean }[]
      ) => void
      const watchFileExplorer = vi.fn(async (_worktree: string, _callback: WatchCallback) => {
        return vi.fn()
      })
      const cleanups = new Map<string, () => void>()
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        watchFileExplorer,
        registerSubscriptionCleanup: vi.fn().mockImplementation((id, cleanup) => {
          cleanups.set(id, cleanup)
        })
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
      const replies: unknown[] = []

      const dispatch = dispatcher.dispatchStreaming(
        makeRequest('files.watch', { worktree: 'id:wt-1' }),
        (response) => replies.push(JSON.parse(response))
      )

      await vi.waitFor(() => {
        expect(replies).toHaveLength(1)
      })
      expect(runtime.watchFileExplorer).toHaveBeenCalledWith('id:wt-1', expect.any(Function))
      expect(replies[0]).toMatchObject({
        ok: true,
        streaming: true,
        result: { type: 'ready', subscriptionId: expect.stringContaining('files-watch-') }
      })

      const emitWatchChange = watchFileExplorer.mock.calls[0]?.[1]
      expect(emitWatchChange).toBeDefined()
      emitWatchChange?.([{ kind: 'update', absolutePath: '/repo/readme.md', isDirectory: false }])
      emitWatchChange?.([
        { kind: 'update', absolutePath: '/repo/package.json', isDirectory: false }
      ])
      expect(replies).toHaveLength(1)

      await vi.runOnlyPendingTimersAsync()

      expect(replies[1]).toMatchObject({
        ok: true,
        streaming: true,
        result: {
          type: 'changed',
          worktree: 'id:wt-1',
          events: [
            { kind: 'update', absolutePath: '/repo/readme.md', isDirectory: false },
            { kind: 'update', absolutePath: '/repo/package.json', isDirectory: false }
          ]
        }
      })

      const ready = replies[0] as { result: { subscriptionId: string } }
      cleanups.get(ready.result.subscriptionId)?.()
      await dispatch

      expect(replies[2]).toMatchObject({
        ok: true,
        streaming: true,
        result: { type: 'end' }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('tears down a file watch that resolves after the connection already closed', async () => {
    type WatchCallback = (
      events: { kind: 'update'; absolutePath: string; isDirectory?: boolean }[]
    ) => void
    const unwatch = vi.fn()
    let resolveWatch: (value: () => void) => void = () => {}
    const watchFileExplorer = vi.fn((_worktree: string, _callback: WatchCallback) => {
      return new Promise<() => void>((resolve) => {
        resolveWatch = resolve
      })
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      watchFileExplorer,
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const abortController = new AbortController()
    const replies: unknown[] = []

    const dispatch = dispatcher.dispatchStreaming(
      makeRequest('files.watch', { worktree: 'id:wt-1' }),
      (response) => replies.push(JSON.parse(response)),
      { connectionId: 'conn-1', signal: abortController.signal }
    )
    await vi.waitFor(() => {
      expect(watchFileExplorer).toHaveBeenCalled()
    })
    abortController.abort()
    await dispatch

    resolveWatch(unwatch)
    await vi.waitFor(() => {
      expect(unwatch).toHaveBeenCalled()
    })
    expect(runtime.registerSubscriptionCleanup).not.toHaveBeenCalled()
    expect(replies).toEqual([])
  })

  it('reads a relative file path for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readMobileFile: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        relativePath: 'src/index.ts',
        content: 'export {}\\n',
        truncated: false,
        byteLength: 10
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.read', { worktree: 'id:wt-1', relativePath: 'src/index.ts' })
    )

    expect(runtime.readMobileFile).toHaveBeenCalledWith('id:wt-1', 'src/index.ts')
    expect(response).toMatchObject({
      ok: true,
      result: { content: 'export {}\\n', truncated: false }
    })
  })

  it('reads a preview file for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readFileExplorerPreview: vi.fn().mockResolvedValue({
        content: 'base64',
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.readPreview', { worktree: 'id:wt-1', relativePath: 'img/logo.png' })
    )

    expect(runtime.readFileExplorerPreview).toHaveBeenCalledWith('id:wt-1', 'img/logo.png')
    expect(response).toMatchObject({
      ok: true,
      result: { content: 'base64', isBinary: true, mimeType: 'image/png' }
    })
  })

  it('reads a file explorer directory for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readFileExplorerDir: vi.fn().mockResolvedValue([{ name: 'src', isDirectory: true }])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.readDir', { worktree: 'id:wt-1', relativePath: '' })
    )

    expect(runtime.readFileExplorerDir).toHaveBeenCalledWith('id:wt-1', '')
    expect(response).toMatchObject({
      ok: true,
      result: [{ name: 'src', isDirectory: true }]
    })
  })

  it('writes file explorer content for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      writeFileExplorerFile: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.write', {
        worktree: 'id:wt-1',
        relativePath: 'src/index.ts',
        content: 'export {}'
      })
    )

    expect(runtime.writeFileExplorerFile).toHaveBeenCalledWith(
      'id:wt-1',
      'src/index.ts',
      'export {}'
    )
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('writes base64 file explorer content for runtime uploads', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      writeFileExplorerFileBase64: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.writeBase64', {
        worktree: 'id:wt-1',
        relativePath: 'assets/logo.png',
        contentBase64: 'cG5n'
      })
    )

    expect(runtime.writeFileExplorerFileBase64).toHaveBeenCalledWith(
      'id:wt-1',
      'assets/logo.png',
      'cG5n'
    )
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('writes base64 file explorer content chunks for large runtime uploads', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      writeFileExplorerFileBase64Chunk: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.writeBase64Chunk', {
        worktree: 'id:wt-1',
        relativePath: 'assets/video.mov',
        contentBase64: 'AAAA',
        append: true
      })
    )

    expect(runtime.writeFileExplorerFileBase64Chunk).toHaveBeenCalledWith(
      'id:wt-1',
      'assets/video.mov',
      'AAAA',
      true
    )
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('commits staged runtime uploads without clobbering the final destination', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      commitFileExplorerUpload: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.commitUpload', {
        worktree: 'id:wt-1',
        tempRelativePath: 'assets/.logo.png.orca-upload-a',
        finalRelativePath: 'assets/logo.png'
      })
    )

    expect(runtime.commitFileExplorerUpload).toHaveBeenCalledWith(
      'id:wt-1',
      'assets/.logo.png.orca-upload-a',
      'assets/logo.png'
    )
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('renames file explorer paths for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      renameFileExplorerPath: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.rename', {
        worktree: 'id:wt-1',
        oldRelativePath: 'old.ts',
        newRelativePath: 'new.ts'
      })
    )

    expect(runtime.renameFileExplorerPath).toHaveBeenCalledWith('id:wt-1', 'old.ts', 'new.ts')
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('copies file explorer paths for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      copyFileExplorerPath: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.copy', {
        worktree: 'id:wt-1',
        sourceRelativePath: 'old.ts',
        destinationRelativePath: 'old copy.ts'
      })
    )

    expect(runtime.copyFileExplorerPath).toHaveBeenCalledWith('id:wt-1', 'old.ts', 'old copy.ts')
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('deletes file explorer paths for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      deleteFileExplorerPath: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.delete', {
        worktree: 'id:wt-1',
        relativePath: 'src',
        recursive: true
      })
    )

    expect(runtime.deleteFileExplorerPath).toHaveBeenCalledWith('id:wt-1', 'src', true)
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('searches files for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      searchRuntimeFiles: vi.fn().mockResolvedValue({
        files: [],
        totalMatches: 0,
        truncated: false
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.search', {
        worktree: 'id:wt-1',
        query: 'needle',
        caseSensitive: true,
        maxResults: 50
      })
    )

    expect(runtime.searchRuntimeFiles).toHaveBeenCalledWith('id:wt-1', {
      query: 'needle',
      caseSensitive: true,
      wholeWord: undefined,
      useRegex: undefined,
      includePattern: undefined,
      excludePattern: undefined,
      maxResults: 50
    })
    expect(response).toMatchObject({ ok: true, result: { files: [], totalMatches: 0 } })
  })

  it('lists all quick-open files for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listRuntimeFiles: vi.fn().mockResolvedValue(['src/index.ts'])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.listAll', {
        worktree: 'id:wt-1',
        excludePaths: ['/repo/other-worktree']
      })
    )

    expect(runtime.listRuntimeFiles).toHaveBeenCalledWith('id:wt-1', {
      excludePaths: ['/repo/other-worktree']
    })
    expect(response).toMatchObject({ ok: true, result: ['src/index.ts'] })
  })

  it('lists markdown documents for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listRuntimeMarkdownDocuments: vi.fn().mockResolvedValue([
        {
          filePath: '/repo/readme.md',
          relativePath: 'readme.md',
          basename: 'readme.md',
          name: 'readme'
        }
      ])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.listMarkdownDocuments', { worktree: 'id:wt-1' })
    )

    expect(runtime.listRuntimeMarkdownDocuments).toHaveBeenCalledWith('id:wt-1')
    expect(response).toMatchObject({ ok: true, result: [{ relativePath: 'readme.md' }] })
  })

  it('stats a relative path for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      statRuntimeFile: vi.fn().mockResolvedValue({ size: 12, isDirectory: false, mtime: 1 })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.stat', { worktree: 'id:wt-1', relativePath: 'readme.md' })
    )

    expect(runtime.statRuntimeFile).toHaveBeenCalledWith('id:wt-1', 'readme.md')
    expect(response).toMatchObject({ ok: true, result: { isDirectory: false } })
  })
})
