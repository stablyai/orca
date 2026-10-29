import type * as NodeFsPromises from 'node:fs/promises'
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import { runProcess } from '@orca/process-host'
import { basename, dirname, join } from 'node:path'
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
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) }
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
  vi.mocked(rename).mockClear()
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
  it.each([false, true])('stores snapshots, preserves reuse: spill=%s', async (spill) => {
    const { source, env, store } = await realDrop()
    const enqueue = localQueue(env, async () => store)
    const reused = (await enqueue({ paths: [source], consumer: 'agent' })).paths[0]
    const sibling = join(dirname(reused), 'notes.txt')
    await writeFile(sibling, 'keep')
    const second = join(dirname(source), 'large.png')
    const bytes = Buffer.alloc(spill ? AGENT_SESSION_ATTACHMENT_MAX_BYTES : 0, 7)
    await writeFile(second, bytes)
    const write = vi.spyOn(store, 'storeFile')
    const move = vi.spyOn(store, 'importFreshFile')
    vi.mocked(open).mockClear()
    const result = await enqueue({
      paths: [source, source, reused, second],
      consumer: 'local-chat'
    })
    expect(result.paths[0]).toBe(result.paths[1])
    expect(result.paths[2]).toBe(reused)
    expect(await readFile(result.paths[0], 'utf8')).toBe('image')
    expect(await readFile(reused, 'utf8')).toBe('image')
    expect(await readFile(sibling, 'utf8')).toBe('keep')
    expect(write).toHaveBeenCalledTimes(spill ? 0 : 2)
    expect(move).toHaveBeenCalledTimes(spill ? 2 : 0)
    const provider = await realpath(env.sourceTempRoot)
    expect(vi.mocked(open).mock.calls.every(([path]) => String(path).startsWith(provider))).toBe(
      true
    )
    expect((await readFile(result.paths[3])).equals(bytes)).toBe(true)
    expect(await readdir(env.copyRoot)).toHaveLength(1)
  })

  it.each([false, true])('keeps immutable fallback: spill=%s', async (spill) => {
    const { source, env } = await realDrop()
    const second = join(dirname(source), 'second.png')
    const bytes = spill
      ? Buffer.alloc(AGENT_SESSION_ATTACHMENT_MAX_BYTES, 7)
      : Buffer.from('second')
    await writeFile(second, bytes)
    const started = deferred<void>()
    const release = deferred<null>()
    const enqueue = localQueue(env, async () => {
      started.resolve()
      await release.promise
      throw new Error('store unavailable')
    })
    const pending = enqueue({ paths: [source, second, source], consumer: 'local-chat' })
    await started.promise
    const staged = await readdir(env.copyRoot).catch(() => [])
    expect(staged).toHaveLength(spill ? 2 : 0)
    await rm(source)
    await writeFile(second, Buffer.alloc(bytes.length, 9))
    release.resolve(null)
    const result = await pending
    expect(result.failures).toEqual([])
    expect(result.paths[0]).toBe(result.paths[2])
    expect(await readFile(result.paths[0], 'utf8')).toBe('image')
    expect((await readFile(result.paths[1])).equals(bytes)).toBe(true)
  })

  it.each(['rename', 'EXDEV', 'failure'] as const)('commits fresh staging: %s', async (mode) => {
    const { source, env, store } = await realDrop()
    await utimes(source, new Date(0), new Date(0))
    if (process.platform === 'darwin') {
      expect((await xattr(['-w', 'com.orca.test-marker', '1', source])).code).toBe(0)
    }
    const enqueue = localQueue(env, async () => store)
    const staging = (await enqueue({ paths: [source], consumer: 'agent' })).paths[0]
    const before = await stat(staging)
    const realRename = (await vi.importActual<typeof NodeFsPromises>('node:fs/promises')).rename
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      expect(await readFile(staging, 'utf8')).toBe('image')
      if (mode !== 'rename') {
        throw Object.assign(new Error(mode), { code: mode === 'EXDEV' ? mode : 'EIO' })
      }
      return realRename(from, to)
    })
    const pending = store.importFreshFile('../shot.png', staging, 5)
    if (mode === 'failure') {
      await expect(pending).rejects.toThrow('failure')
      expect(await readFile(staging, 'utf8')).toBe('image')
      expect(await readdir(store.rootDir)).toEqual([])
    } else {
      const stored = await pending
      expect(basename(stored)).toBe('shot.png')
      expect(basename(dirname(stored))).toMatch(/^[0-9a-f-]{36}$/)
      expect(await readFile(stored, 'utf8')).toBe('image')
      expect((await stat(dirname(stored))).mtimeMs).toBeGreaterThan(Date.now() - 60_000)
      expect((await stat(stored)).mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs)
      if (process.platform !== 'win32') {
        expect((await stat(stored)).mode & 0o777).toBe(0o600)
      }
      if (mode === 'rename') {
        await expect(stat(staging)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect(await readFile(staging, 'utf8')).toBe('image')
      }
      if (process.platform === 'darwin') {
        expect((await xattr([stored])).stdout).not.toContain('com.orca.test-marker')
      }
    }
  })

  it.each([false, true])('advances after abandon: spill=%s', async (spill) => {
    const { source, env, store } = await realDrop()
    const paths = [source]
    if (spill) {
      paths.push(join(dirname(source), 'large.png'))
      await writeFile(paths[1], Buffer.alloc(AGENT_SESSION_ATTACHMENT_MAX_BYTES))
    }
    const started = deferred<void>()
    const completed = deferred<string>()
    const release = deferred<string>()
    onTestFinished(() => release.resolve('done'))
    const hold = async (publish: () => Promise<string>) => {
      let final = spill ? await publish() : undefined
      started.resolve()
      await release.promise
      final ??= await publish()
      completed.resolve(final)
      return final
    }
    if (spill) {
      vi.spyOn(store, 'importFreshFile').mockImplementationOnce((...args) =>
        hold(() => AgentSessionAttachmentStore.prototype.importFreshFile.apply(store, args))
      )
    } else {
      vi.spyOn(store, 'storeFile').mockImplementationOnce((...args) =>
        hold(() => AgentSessionAttachmentStore.prototype.storeFile.apply(store, args))
      )
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => void vi.useRealTimers())
    const enqueue = localQueue(env, async () => store, 100)
    const abandoned = enqueue({ paths, consumer: 'local-chat' })
    await started.promise
    const following = enqueue({ paths: [source], consumer: 'agent' })
    await vi.advanceTimersByTimeAsync(100)
    await expect(abandoned).resolves.toMatchObject({
      paths: [],
      failures: [{ commonReason: 'timed-out' }]
    })
    expect(await readFile((await following).paths[0], 'utf8')).toBe('image')
    vi.useRealTimers()
    await vi.waitFor(async () => expect(await readdir(env.copyRoot)).toHaveLength(1))
    release.resolve('done')
    const final = await completed.promise
    expect(await readFile(final, 'utf8')).toBe('image')
    expect(store.isUploadInFlight(basename(dirname(final)))).toBe(false)
    expect(await readFile(source, 'utf8')).toBe('image')
    expect(await readdir(env.copyRoot)).toHaveLength(1)
    await expect(abandoned).resolves.toMatchObject({ paths: [] })
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
