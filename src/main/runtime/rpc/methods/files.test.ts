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

  it('opens a source control diff for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      openMobileDiff: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        relativePath: 'docs/readme.md',
        kind: 'markdown',
        opened: true
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.openDiff', {
        worktree: 'id:wt-1',
        relativePath: 'docs/readme.md',
        staged: true
      })
    )

    expect(runtime.openMobileDiff).toHaveBeenCalledWith('id:wt-1', 'docs/readme.md', true)
    expect(response).toMatchObject({
      ok: true,
      result: { kind: 'markdown', opened: true }
    })
  })

  it('browses server directories before a project is added', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      browseServerDir: vi.fn().mockResolvedValue({
        resolvedPath: '/home/me',
        entries: [{ name: 'project', isDirectory: true, isSymlink: false }]
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(makeRequest('files.browseServerDir', { path: '~' }))

    expect(runtime.browseServerDir).toHaveBeenCalledWith('~')
    expect(response).toMatchObject({
      ok: true,
      result: { resolvedPath: '/home/me', entries: [{ name: 'project', isDirectory: true }] }
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
        expect(replies).toHaveLength(2)
      })
      expect(runtime.watchFileExplorer).toHaveBeenCalledWith(
        'id:wt-1',
        expect.any(Function),
        expect.any(Function),
        expect.any(AbortSignal)
      )
      expect(replies[0]).toMatchObject({
        ok: true,
        streaming: true,
        result: { type: 'starting', subscriptionId: expect.stringContaining('files-watch-') }
      })
      expect(replies[1]).toMatchObject({
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
      expect(replies).toHaveLength(2)

      await vi.runOnlyPendingTimersAsync()

      expect(replies[2]).toMatchObject({
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

      const ready = replies[1] as { result: { subscriptionId: string } }
      cleanups.get(ready.result.subscriptionId)?.()
      await dispatch

      expect(replies[3]).toMatchObject({
        ok: true,
        streaming: true,
        result: { type: 'end' }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends a ready file-watch stream when its watcher fails terminally', async () => {
    let onTerminalError: ((error: Error) => void) | undefined
    const unwatch = vi.fn()
    const cleanups = new Map<string, () => void>()
    let emitWatchChange:
      | ((events: { kind: 'overflow'; absolutePath: string }[]) => void)
      | undefined
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      watchFileExplorer: vi.fn(async (_worktree, callback, nextTerminalError) => {
        emitWatchChange = callback
        onTerminalError = nextTerminalError
        return unwatch
      }),
      registerSubscriptionCleanup: vi.fn((id, cleanup) => cleanups.set(id, cleanup)),
      cleanupSubscription: vi.fn((id) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const replies: { result?: { type?: string; message?: string } }[] = []

    const dispatch = dispatcher.dispatchStreaming(
      makeRequest('files.watch', { worktree: 'id:wt-1' }),
      (response) => replies.push(JSON.parse(response))
    )
    await vi.waitFor(() => expect(replies[1]?.result?.type).toBe('ready'))

    emitWatchChange?.([{ kind: 'overflow', absolutePath: '/repo' }])
    onTerminalError?.(new Error('file watcher process crashed repeatedly'))
    await dispatch

    expect(replies.map((reply) => reply.result?.type)).toEqual([
      'starting',
      'ready',
      'changed',
      'error',
      'end'
    ])
    expect(replies[3]?.result?.message).toContain('crashed repeatedly')
    expect(unwatch).toHaveBeenCalledTimes(1)
    expect(cleanups.size).toBe(0)
  })

  it('tears down a file watch that resolves after the connection already closed', async () => {
    type WatchCallback = (
      events: { kind: 'update'; absolutePath: string; isDirectory?: boolean }[]
    ) => void
    const unwatch = vi.fn()
    let resolveWatch: (value: () => void) => void = () => {}
    const watchFileExplorer = vi.fn(
      (
        _worktree: string,
        _callback: WatchCallback,
        _onTerminalError?: (error: Error) => void,
        _signal?: AbortSignal
      ) =>
        new Promise<() => void>((resolve) => {
          resolveWatch = resolve
        })
    )
    const cleanups = new Map<string, () => void | Promise<void>>()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      watchFileExplorer,
      registerSubscriptionCleanup: vi.fn((id, cleanup) => cleanups.set(id, cleanup)),
      cleanupSubscription: vi.fn((id) => {
        void Promise.resolve(cleanups.get(id)?.())
      })
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
    const setupSignal = watchFileExplorer.mock.calls[0]?.[3]
    expect(setupSignal).not.toBe(abortController.signal)
    abortController.abort()
    expect(setupSignal?.aborted).toBe(true)
    await dispatch

    resolveWatch(unwatch)
    await vi.waitFor(() => {
      expect(unwatch).toHaveBeenCalled()
    })
    expect(runtime.registerSubscriptionCleanup).toHaveBeenCalledTimes(1)
    expect(replies).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ type: 'starting' }) }),
      expect.objectContaining({ result: { type: 'end' } })
    ])
  })

  it('reports files.unwatch failure instead of acknowledging incomplete teardown', async () => {
    const cleanupError = new Error('file watcher process did not exit after termination deadline')
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      cleanupSubscriptionAndWait: vi.fn().mockRejectedValue(cleanupError)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.unwatch', { subscriptionId: 'files-watch-inproc-1' })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining(cleanupError.message) }
    })
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

  it('resolves a tapped terminal path for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveTerminalPath: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        relativePath: 'src/index.ts',
        exists: true,
        isDirectory: false
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.resolveTerminalPath', {
        worktree: 'id:wt-1',
        pathText: '/repo/src/index.ts',
        cwd: '/repo',
        terminal: 'term-1'
      })
    )

    expect(runtime.resolveTerminalPath).toHaveBeenCalledWith(
      'id:wt-1',
      '/repo/src/index.ts',
      '/repo',
      undefined,
      'term-1'
    )
    expect(response).toMatchObject({
      ok: true,
      result: { relativePath: 'src/index.ts', exists: true, isDirectory: false }
    })
  })

  it('reads a terminal artifact through a grant-scoped method', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readTerminalArtifactFile: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        relativePath: '/tmp/result.json',
        content: '{}',
        truncated: false,
        byteLength: 2
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.readTerminalArtifact', {
        worktree: 'id:wt-1',
        absolutePath: '/tmp/result.json',
        grantId: 'grant-1'
      })
    )

    expect(runtime.readTerminalArtifactFile).toHaveBeenCalledWith(
      'id:wt-1',
      'grant-1',
      '/tmp/result.json',
      undefined
    )
    expect(response).toMatchObject({ ok: true, result: { content: '{}' } })
  })

  it('writes a terminal artifact through a grant-scoped method', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      writeTerminalArtifactFile: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    await dispatcher.dispatch(
      makeRequest('files.writeTerminalArtifact', {
        worktree: 'id:wt-1',
        absolutePath: '/tmp/result.json',
        grantId: 'grant-1',
        content: '{}'
      })
    )

    expect(runtime.writeTerminalArtifactFile).toHaveBeenCalledWith(
      'id:wt-1',
      'grant-1',
      '/tmp/result.json',
      '{}',
      undefined
    )
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

  it('reads a file chunk for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readFileExplorerChunk: vi.fn().mockResolvedValue({
        contentBase64: 'YWJj',
        bytesRead: 3,
        eof: true
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.readChunk', {
        worktree: 'id:wt-1',
        relativePath: 'archive.zip',
        offset: 0,
        length: 1024
      })
    )

    expect(runtime.readFileExplorerChunk).toHaveBeenCalledWith('id:wt-1', 'archive.zip', 0, 1024)
    expect(response).toMatchObject({
      ok: true,
      result: { contentBase64: 'YWJj', bytesRead: 3, eof: true }
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

  it.each([
    ['missing content', { worktree: 'id:wt-1', relativePath: 'src/index.ts' }],
    ['null content', { worktree: 'id:wt-1', relativePath: 'src/index.ts', content: null }],
    ['non-string content', { worktree: 'id:wt-1', relativePath: 'src/index.ts', content: 0 }]
  ])('rejects a write with %s instead of truncating the file', async (_name, params) => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      writeFileExplorerFile: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(makeRequest('files.write', params))

    expect(response).toMatchObject({ ok: false })
    expect(runtime.writeFileExplorerFile).not.toHaveBeenCalled()
  })

  it('still allows writing an explicit empty string (empty file)', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      writeFileExplorerFile: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.write', { worktree: 'id:wt-1', relativePath: 'src/index.ts', content: '' })
    )

    expect(runtime.writeFileExplorerFile).toHaveBeenCalledWith('id:wt-1', 'src/index.ts', '')
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('allows writing explicit empty base64 content', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      writeFileExplorerFileBase64: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.writeBase64', {
        worktree: 'id:wt-1',
        relativePath: 'assets/logo.png',
        contentBase64: ''
      })
    )

    expect(runtime.writeFileExplorerFileBase64).toHaveBeenCalledWith(
      'id:wt-1',
      'assets/logo.png',
      ''
    )
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it.each([
    ['missing content', { worktree: 'id:wt-1', relativePath: 'assets/logo.png' }],
    ['null content', { worktree: 'id:wt-1', relativePath: 'assets/logo.png', contentBase64: null }],
    [
      'non-string content',
      { worktree: 'id:wt-1', relativePath: 'assets/logo.png', contentBase64: 0 }
    ],
    [
      'malformed content',
      { worktree: 'id:wt-1', relativePath: 'assets/logo.png', contentBase64: '!!!!' }
    ]
  ])('rejects a base64 write with %s', async (_name, params) => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      writeFileExplorerFileBase64: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(makeRequest('files.writeBase64', params))

    expect(response).toMatchObject({ ok: false })
    expect(runtime.writeFileExplorerFileBase64).not.toHaveBeenCalled()
  })

  it('allows writing an explicit empty base64 chunk', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      writeFileExplorerFileBase64Chunk: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.writeBase64Chunk', {
        worktree: 'id:wt-1',
        relativePath: 'assets/video.mov',
        contentBase64: '',
        append: true
      })
    )

    expect(runtime.writeFileExplorerFileBase64Chunk).toHaveBeenCalledWith(
      'id:wt-1',
      'assets/video.mov',
      '',
      true
    )
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it.each([
    [
      'missing content',
      {
        worktree: 'id:wt-1',
        relativePath: 'assets/video.mov',
        append: true
      }
    ],
    [
      'null content',
      {
        worktree: 'id:wt-1',
        relativePath: 'assets/video.mov',
        contentBase64: null,
        append: true
      }
    ],
    [
      'non-string content',
      {
        worktree: 'id:wt-1',
        relativePath: 'assets/video.mov',
        contentBase64: 0,
        append: true
      }
    ],
    [
      'malformed content',
      {
        worktree: 'id:wt-1',
        relativePath: 'assets/video.mov',
        contentBase64: '!!!!',
        append: true
      }
    ]
  ])('rejects a base64 chunk write with %s (inherits the schema)', async (_name, params) => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      writeFileExplorerFileBase64Chunk: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(makeRequest('files.writeBase64Chunk', params))

    expect(response).toMatchObject({ ok: false })
    expect(runtime.writeFileExplorerFileBase64Chunk).not.toHaveBeenCalled()
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

    await dispatcher.dispatch(
      makeRequest('files.delete', {
        worktree: 'id:wt-1',
        relativePath: 'src',
        recursive: true
      })
    )

    expect(runtime.deleteFileExplorerPath).toHaveBeenCalledWith('id:wt-1', 'src', true)
  })

  it('forwards the captured SSH target and generation for destructive mutations', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      deleteFileExplorerPath: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.delete', {
        worktree: 'id:wt-1',
        relativePath: 'src',
        recursive: true,
        expectedExecutionHostId: 'ssh:ssh-1',
        expectedSshTargetId: 'ssh-1',
        expectedSshConnectionGeneration: 7
      })
    )

    expect(runtime.deleteFileExplorerPath).toHaveBeenCalledWith(
      'id:wt-1',
      'src',
      true,
      7,
      'ssh-1',
      'ssh:ssh-1'
    )
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
