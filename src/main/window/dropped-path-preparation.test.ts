import type * as NodeFsPromises from 'node:fs/promises'
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import { runProcess } from '@orca/process-host'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DragTempCopyItemResult } from './dragged-temp-file-copy'
import type * as DragTempFileCopy from './dragged-temp-file-copy'
import {
  createDragTempCopyLane,
  createDroppedPathPreparationQueue,
  MAX_PENDING_DRAG_TEMP_COPIES
} from './dropped-path-preparation'

const materialize = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof NodeFsPromises>()
  return { ...actual, open: vi.fn(actual.open) }
})
vi.mock('electron', () => ({ app: {}, ipcMain: {} }))
vi.mock('./dragged-temp-file-copy', async (original) => ({
  ...(await original<typeof DragTempFileCopy>()),
  materializeDragTempPaths: materialize
}))
const TEMP = join('/', 'var', 'T', 'TemporaryItems', 'NSIRD_one', 'Shot.png')
const ORDINARY = join('/', 'files', 'notes.txt')
const COPY = join('/', 'var', 'T', 'orca-drops', 'orca-drop-abc123', 'Shot.png')
const env = { platform: 'darwin' as const, sourceTempRoot: '/var/T', copyRoot: '/var/T/drops' }

function queue(lane = createDragTempCopyLane(), copyTimeoutMs = 1000) {
  const controller = new AbortController()
  const dispose = vi.fn()
  const enqueue = createDroppedPathPreparationQueue(
    {
      platform: 'darwin',
      getCopyEnvironment: async () => env,
      watchRenderer: () => ({ signal: controller.signal, dispose }),
      copyTimeoutMs
    },
    lane
  )
  return {
    enqueue: async (request: Parameters<typeof enqueue>[0]) => enqueue(request),
    controller,
    dispose
  }
}
function deferred<T = DragTempCopyItemResult[]>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
beforeEach(() => {
  materialize.mockReset()
  vi.mocked(open).mockClear()
})

async function realDrop() {
  const root = await mkdtemp(join(tmpdir(), 'orca-30419-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const sourceTempRoot = join(root, 'T')
  const source = join(sourceTempRoot, 'TemporaryItems', 'NSIRD_test', 'shot.png')
  await mkdir(join(source, '..'), { recursive: true })
  await writeFile(source, 'image')
  const actual = await vi.importActual<typeof DragTempFileCopy>('./dragged-temp-file-copy')
  materialize.mockImplementation(actual.materializeDragTempPaths)
  return {
    source,
    env: { platform: 'darwin' as const, sourceTempRoot, copyRoot: join(root, 'drops') },
    store: new AgentSessionAttachmentStore(join(root, 'store'), { hasSession: () => false })
  }
}

async function xattr(args: string[]) {
  return runProcess({ program: '/usr/bin/xattr', args })
}

function localQueue(
  environment: DragTempFileCopy.DragTempCopyEnvironment,
  getStore: () => Promise<AgentSessionAttachmentStore | null>,
  copyTimeoutMs = 3000
) {
  return createDroppedPathPreparationQueue({
    platform: 'darwin',
    getCopyEnvironment: async () => environment,
    watchRenderer: () => ({ signal: new AbortController().signal, dispose: vi.fn() }),
    localChatAttachmentStore: getStore,
    copyTimeoutMs
  })
}

describe('dropped path preparation through the shared copy queue', () => {
  it("writes a local chat's drag-temp files once, straight into the chat store", async () => {
    const { source, env, store } = await realDrop()
    const enqueue = localQueue(env, async () => store)
    const reused = (await enqueue({ paths: [source], consumer: 'agent' })).paths[0]
    const sibling = join(dirname(reused), 'notes.txt')
    await writeFile(sibling, 'keep')
    const large = join(dirname(source), 'large.png')
    const bytes = Buffer.alloc(AGENT_SESSION_ATTACHMENT_MAX_BYTES, 7)
    await writeFile(large, bytes)
    if (process.platform === 'darwin') {
      expect((await xattr(['-w', 'com.orca.test-marker', '1', source])).code).toBe(0)
    }
    const write = vi.spyOn(store, 'storeWith')
    const bufferedWrite = vi.spyOn(store, 'storeFile')
    vi.mocked(open).mockClear()
    const result = await enqueue({ paths: [source, source, reused, large], consumer: 'local-chat' })
    expect(result.failures).toEqual([])
    expect(result.paths[0]).toBe(result.paths[1])
    expect(result.paths[2]).toBe(reused)
    expect(dirname(dirname(result.paths[0]))).toBe(store.rootDir)
    expect(await readFile(result.paths[0], 'utf8')).toBe('image')
    expect((await readFile(result.paths[3])).equals(bytes)).toBe(true)
    expect(write).toHaveBeenCalledTimes(2)
    expect(bufferedWrite).toHaveBeenCalledTimes(1)
    // Only the earlier terminal drop's copy: nothing was staged in the temp folder.
    expect(await readdir(env.copyRoot)).toHaveLength(1)
    expect(await readFile(sibling, 'utf8')).toBe('keep')
    if (process.platform !== 'win32') {
      expect((await stat(result.paths[3])).mode & 0o777).toBe(0o600)
    }
    if (process.platform === 'darwin') {
      expect((await xattr([result.paths[0]])).stdout).not.toContain('com.orca.test-marker')
    }
    // Each dropped file is opened once, in the provider's folder, and never reopened by path.
    const provider = await realpath(env.sourceTempRoot)
    expect(vi.mocked(open).mock.calls.map(([path]) => String(path))).toEqual([
      join(provider, 'TemporaryItems', 'NSIRD_test', 'shot.png'),
      join(provider, 'TemporaryItems', 'NSIRD_test', 'large.png')
    ])
  })

  it('captures bytes and closes the source before requesting the chat store', async () => {
    const { source, env, store } = await realDrop()
    const getStore = vi.fn(async () => {
      expect(open).toHaveBeenCalledTimes(1)
      expect((await vi.mocked(open).mock.results[0].value).fd).toBe(-1)
      await writeFile(source, 'changed after capture')
      return store
    })
    const result = await localQueue(env, getStore)({ paths: [source], consumer: 'local-chat' })
    expect(result.failures).toEqual([])
    expect(getStore).toHaveBeenCalledTimes(1)
    await expect(getStore.mock.results[0].value).resolves.toBe(store)
    expect(await readFile(result.paths[0], 'utf8')).toBe('image')
  })

  it('copies a file over the chat attachment limit privately without waiting for the chat host', async () => {
    const { source, env } = await realDrop()
    await writeFile(source, Buffer.alloc(AGENT_SESSION_ATTACHMENT_MAX_BYTES + 1, 3))
    const getStore = vi.fn(async () => null)
    const result = await localQueue(env, getStore)({ paths: [source], consumer: 'local-chat' })
    expect(result.failures).toEqual([])
    expect(dirname(dirname(result.paths[0]))).toBe(env.copyRoot)
    expect((await stat(result.paths[0])).size).toBe(AGENT_SESSION_ATTACHMENT_MAX_BYTES + 1)
    expect(getStore).not.toHaveBeenCalled()
  })

  it.each(['SECOND-rewritten', 'x'])(
    'keeps captured bytes after provider removal or rewrite to %s',
    async (rewritten) => {
      const { source, env, store } = await realDrop()
      const second = join(dirname(source), 'second.png')
      await writeFile(second, 'second')
      const started = deferred<void>()
      const release = deferred<null>()
      const enqueue = localQueue(env, async () => {
        started.resolve()
        await release.promise
        return store
      })
      const pending = enqueue({ paths: [source, second, source], consumer: 'local-chat' })
      await started.promise
      await rm(source)
      await writeFile(second, rewritten)
      release.resolve(null)
      const result = await pending
      expect(result.paths).toHaveLength(3)
      expect(result.paths[0]).toBe(result.paths[2])
      expect(await readFile(result.paths[0], 'utf8')).toBe('image')
      expect(await readFile(result.paths[1], 'utf8')).toBe('second')
      expect(result.failures).toEqual([])
    }
  )

  it.each(['unavailable', 'refused', 'write fails'] as const)(
    'keeps the checked bytes as a private copy when the store %s',
    async (mode) => {
      const { source, env, store } = await realDrop()
      if (mode === 'write fails') {
        vi.spyOn(store, 'storeFile').mockRejectedValueOnce(new Error('EIO'))
      }
      const enqueue = localQueue(env, async () => {
        await rm(source)
        if (mode === 'refused') {
          throw new Error('host refused')
        }
        return mode === 'unavailable' ? null : store
      })
      const result = await enqueue({ paths: [source], consumer: 'local-chat' })
      expect(result.failures).toEqual([])
      expect(dirname(dirname(result.paths[0]))).toBe(env.copyRoot)
      expect(await readFile(result.paths[0], 'utf8')).toBe('image')
      if (process.platform !== 'win32') {
        expect((await stat(result.paths[0])).mode & 0o777).toBe(0o600)
      }
      expect(await readdir(store.rootDir).catch(() => [])).toEqual([])
    }
  )

  it('keeps an unlinked over-budget source after the store destination write fails', async () => {
    const { source, env, store } = await realDrop()
    const buffered = join(dirname(source), 'buffered.png')
    await writeFile(buffered, Buffer.alloc(AGENT_SESSION_ATTACHMENT_MAX_BYTES))
    const storeWith = store.storeWith.bind(store)
    const write = vi.spyOn(store, 'storeWith').mockImplementation((name, writePart) =>
      name !== 'shot.png'
        ? storeWith(name, writePart)
        : storeWith(name, async (partPath) => {
            await rm(source)
            // The real writer must fail at its destination, after taking the source handle.
            await mkdir(partPath)
            await writePart(partPath)
          })
    )
    const result = await localQueue(
      env,
      async () => store
    )({
      paths: [buffered, source],
      consumer: 'local-chat'
    })
    await expect(write.mock.results[1].value).rejects.toMatchObject({ code: 'EEXIST' })
    expect(result.failures).toEqual([])
    expect(dirname(dirname(result.paths[1]))).toBe(env.copyRoot)
    expect(await readFile(result.paths[1], 'utf8')).toBe('image')
    expect(await readdir(store.rootDir)).toHaveLength(1)
    expect(vi.mocked(open)).toHaveBeenCalledTimes(2)
    expect((await vi.mocked(open).mock.results[1].value).fd).toBe(-1)
  })

  it('opens and stores each unique source once as drop size grows tenfold', async () => {
    for (const count of [4, 40]) {
      const { source, env, store } = await realDrop()
      const paths = Array.from({ length: count }, (_, index) =>
        join(dirname(source), `shot-${index}.png`)
      )
      for (const path of paths) {
        await writeFile(path, 'image')
      }
      vi.mocked(open).mockClear()
      const write = vi.spyOn(store, 'storeWith')
      const getStore = vi.fn(async () => store)
      const result = await localQueue(
        env,
        getStore
      )({
        paths: [...paths, ...paths],
        consumer: 'local-chat'
      })
      expect(result.failures).toEqual([])
      expect(result.paths).toHaveLength(2 * count)
      expect(result.paths.slice(count)).toEqual(result.paths.slice(0, count))
      expect(getStore).toHaveBeenCalledTimes(1)
      expect(open).toHaveBeenCalledTimes(count)
      expect(write).toHaveBeenCalledTimes(count)
      const handles = await Promise.all(vi.mocked(open).mock.results.map((call) => call.value))
      expect(handles.every((handle) => handle.fd === -1)).toBe(true)
    }
  })

  it('closes the dropped files when the chat host never starts and serves the next drop', async () => {
    const { source, env } = await realDrop()
    const never = deferred<AgentSessionAttachmentStore | null>()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => void vi.useRealTimers())
    const enqueue = localQueue(env, () => never.promise, 100)
    vi.mocked(open).mockClear()
    const abandoned = enqueue({ paths: [source], consumer: 'local-chat' })
    await vi.waitFor(() => expect(vi.mocked(open)).toHaveBeenCalled())
    const following = enqueue({ paths: [source], consumer: 'agent' })
    await vi.advanceTimersByTimeAsync(100)
    await expect(abandoned).resolves.toMatchObject({
      paths: [],
      failures: [{ commonReason: 'timed-out' }]
    })
    vi.useRealTimers()
    expect(await readFile((await following).paths[0], 'utf8')).toBe('image')
    const handles = await Promise.all(vi.mocked(open).mock.results.map((call) => call.value))
    expect(handles.every((handle) => handle.fd === -1)).toBe(true)
  })

  it.each(['agent', 'main-reader'] as const)(
    'passes ordinary paths without copying for %s',
    async (consumer) => {
      const { enqueue } = queue()
      await expect(enqueue({ paths: [ORDINARY], consumer })).resolves.toEqual({
        paths: [ORDINARY],
        failures: []
      })
      expect(materialize).not.toHaveBeenCalled()
    }
  )

  it.each(['agent', 'main-reader'] as const)(
    'withholds uncopied originals only from agents: %s',
    async (consumer) => {
      materialize.mockResolvedValue([
        { sourcePath: ORDINARY, status: 'imported', destPath: ORDINARY },
        { sourcePath: TEMP, status: 'uncopied', reason: 'storage-full' }
      ])
      const { enqueue } = queue()
      const result = await enqueue({ paths: [ORDINARY, TEMP], consumer })
      expect(result.paths).toEqual(consumer === 'agent' ? [ORDINARY] : [ORDINARY, TEMP])
      expect(result.failures).toEqual(
        consumer === 'agent'
          ? [
              {
                byteLength: 0,
                pathCount: 1,
                reason: 'temp-copy-failed',
                target: 'rejected',
                commonReason: 'storage-full'
              }
            ]
          : []
      )
    }
  )

  it('preserves ordinary successes and copied successes when another file fails', async () => {
    materialize.mockResolvedValue([
      { sourcePath: ORDINARY, status: 'imported', destPath: ORDINARY },
      { sourcePath: TEMP, status: 'imported', destPath: COPY },
      { sourcePath: TEMP, status: 'failed', reason: 'missing' }
    ])
    const result = await queue().enqueue({
      paths: [ORDINARY, TEMP, TEMP],
      consumer: 'agent'
    })
    expect(result.paths).toEqual([ORDINARY, COPY])
    expect(result.failures[0]).toMatchObject({ pathCount: 1, commonReason: 'missing' })
  })

  it('serializes copy requests from different owners', async () => {
    const first = deferred()
    materialize
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    const { enqueue } = queue()
    const chat = enqueue({ paths: [TEMP], consumer: 'agent' })
    const editor = enqueue({ paths: [TEMP], consumer: 'main-reader' })
    await settle()
    expect(materialize).toHaveBeenCalledTimes(1)
    first.resolve([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    await expect(chat).resolves.toEqual({ paths: [COPY], failures: [] })
    await expect(editor).resolves.toEqual({ paths: [COPY], failures: [] })
    expect(materialize).toHaveBeenCalledTimes(2)
  })

  it('shares serialization and the pending cap across replacement-window queues', async () => {
    materialize.mockReturnValue(new Promise(() => undefined))
    const lane = createDragTempCopyLane()
    const first = queue(lane)
    const second = queue(lane)
    const results = Array.from({ length: MAX_PENDING_DRAG_TEMP_COPIES }, () =>
      first.enqueue({ paths: [TEMP], consumer: 'agent' }).catch(() => undefined)
    )
    await expect(
      second.enqueue({ paths: [ORDINARY, TEMP], consumer: 'agent' })
    ).resolves.toMatchObject({ paths: [ORDINARY], failures: [{ commonReason: 'busy' }] })
    first.controller.abort(new Error('test ended'))
    await Promise.all(results)
    await settle()
    expect(materialize).toHaveBeenCalledTimes(1)
  })

  it('lets another owner prepare ordinary paths while a copy waits', async () => {
    const copy = deferred()
    materialize.mockReturnValueOnce(copy.promise)
    const { enqueue } = queue()
    const pending = enqueue({ paths: [TEMP], consumer: 'agent' })
    await expect(enqueue({ paths: [ORDINARY], consumer: 'main-reader' })).resolves.toEqual({
      paths: [ORDINARY],
      failures: []
    })
    copy.resolve([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    await pending
  })

  it('aborts running and queued requests on reload and releases their listeners', async () => {
    materialize.mockReturnValue(new Promise(() => undefined))
    const { enqueue, controller, dispose } = queue()
    const running = enqueue({ paths: [TEMP], consumer: 'agent' })
    const queued = enqueue({ paths: [TEMP], consumer: 'agent' })
    const assertions = [
      expect(running).rejects.toThrow('reloaded'),
      expect(queued).rejects.toThrow('reloaded')
    ]
    await settle()
    controller.abort(new Error('reloaded'))
    await Promise.all(assertions)
    await settle()
    expect(materialize).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('reports timeout, keeps ordinary paths, and serves the next copy', async () => {
    materialize
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    const { enqueue } = queue(undefined, 5)
    const first = enqueue({ paths: [ORDINARY, TEMP], consumer: 'agent' })
    const next = enqueue({ paths: [TEMP], consumer: 'agent' })
    await expect(first).resolves.toMatchObject({
      paths: [ORDINARY],
      failures: [{ commonReason: 'timed-out' }]
    })
    await expect(next).resolves.toEqual({ paths: [COPY], failures: [] })
  })
  it('passes drag-temp-looking paths unchanged on Linux and Windows', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const enqueue = createDroppedPathPreparationQueue({
        platform,
        getCopyEnvironment: async () => env,
        watchRenderer: () => ({ signal: new AbortController().signal, dispose: vi.fn() })
      })
      expect(enqueue({ paths: [TEMP], consumer: 'agent' })).toEqual({ paths: [TEMP], failures: [] })
    }
    expect(materialize).not.toHaveBeenCalled()
  })

  it('reports all lost paths without a shared reason when their failures differ', async () => {
    materialize.mockResolvedValue([
      { sourcePath: TEMP, status: 'failed', reason: 'missing' },
      { sourcePath: TEMP, status: 'failed', reason: 'changed' }
    ])
    await expect(queue().enqueue({ paths: [TEMP, TEMP], consumer: 'agent' })).resolves.toEqual({
      paths: [],
      failures: [{ byteLength: 0, pathCount: 2, reason: 'temp-copy-failed', target: 'rejected' }]
    })
  })

  it('keeps ordinary paths and serves the next drop when the copy environment fails', async () => {
    const getCopyEnvironment = vi.fn(async () => env)
    getCopyEnvironment.mockRejectedValueOnce(new Error('no temp path'))
    const enqueue = createDroppedPathPreparationQueue({
      platform: 'darwin',
      getCopyEnvironment,
      watchRenderer: () => ({ signal: new AbortController().signal, dispose: vi.fn() })
    })
    await expect(enqueue({ paths: [ORDINARY, TEMP], consumer: 'agent' })).resolves.toEqual({
      paths: [ORDINARY],
      failures: [{ byteLength: 0, pathCount: 1, reason: 'temp-copy-failed', target: 'rejected' }]
    })
    materialize.mockResolvedValue([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    await expect(enqueue({ paths: [TEMP], consumer: 'agent' })).resolves.toEqual({
      paths: [COPY],
      failures: []
    })
  })
})
