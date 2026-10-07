import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DragTempCopyItemResult } from './dragged-temp-file-copy'
import type * as DragTempFileCopy from './dragged-temp-file-copy'
import type { NativeFileDropPayload } from '../../shared/native-file-drop'
import { createDragTempCopyLane, MAX_PENDING_DRAG_TEMP_COPIES } from './dropped-path-preparation'
import { createNativeFileDropQueue } from './native-file-drop-relay'

const materialize = vi.hoisted(() => vi.fn())
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
  const forwarded: NativeFileDropPayload[] = []
  const dispose = vi.fn()
  const enqueue = createNativeFileDropQueue(
    {
      platform: 'darwin',
      getCopyEnvironment: async () => env,
      watchRenderer: () => ({ signal: controller.signal, dispose }),
      forward: (payload) => forwarded.push(payload),
      copyTimeoutMs
    },
    lane
  )
  return { enqueue, controller, forwarded, dispose }
}
function deferred() {
  let resolve!: (value: DragTempCopyItemResult[]) => void
  const promise = new Promise<DragTempCopyItemResult[]>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
beforeEach(() => {
  materialize.mockReset()
})

describe('dropped path preparation through the shared relay queue', () => {
  it.each(['agent', 'main-reader'] as const)(
    'passes ordinary paths without copying for %s',
    async (consumer) => {
      const { enqueue } = queue()
      await expect(enqueue.prepare({ paths: [ORDINARY], consumer })).resolves.toEqual({
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
      const result = await enqueue.prepare({ paths: [ORDINARY, TEMP], consumer })
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
    const result = await queue().enqueue.prepare({
      paths: [ORDINARY, TEMP, TEMP],
      consumer: 'agent'
    })
    expect(result.paths).toEqual([ORDINARY, COPY])
    expect(result.failures[0]).toMatchObject({ pathCount: 1, commonReason: 'missing' })
  })

  it('serializes requests and the legacy relay together', async () => {
    const first = deferred()
    materialize
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    const { enqueue, forwarded } = queue()
    enqueue({ paths: [TEMP], target: 'terminal' })
    const requested = enqueue.prepare({ paths: [TEMP], consumer: 'agent' })
    await settle()
    expect(materialize).toHaveBeenCalledTimes(1)
    first.resolve([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    await expect(requested).resolves.toEqual({ paths: [COPY], failures: [] })
    await settle()
    expect(forwarded).toEqual([{ paths: [COPY], target: 'terminal' }])
    expect(materialize).toHaveBeenCalledTimes(2)
  })

  it('shares serialization and the pending cap across replacement-window queues', async () => {
    materialize.mockReturnValue(new Promise(() => undefined))
    const lane = createDragTempCopyLane()
    const first = queue(lane)
    const second = queue(lane)
    const results = Array.from({ length: MAX_PENDING_DRAG_TEMP_COPIES }, () =>
      first.enqueue.prepare({ paths: [TEMP], consumer: 'agent' }).catch(() => undefined)
    )
    await expect(
      second.enqueue.prepare({ paths: [ORDINARY, TEMP], consumer: 'agent' })
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
    const pending = enqueue.prepare({ paths: [TEMP], consumer: 'agent' })
    await expect(enqueue.prepare({ paths: [ORDINARY], consumer: 'main-reader' })).resolves.toEqual({
      paths: [ORDINARY],
      failures: []
    })
    copy.resolve([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    await pending
  })

  it('aborts running and queued requests on reload and releases their listeners', async () => {
    materialize.mockReturnValue(new Promise(() => undefined))
    const { enqueue, controller, dispose } = queue()
    const running = enqueue.prepare({ paths: [TEMP], consumer: 'agent' })
    const queued = enqueue.prepare({ paths: [TEMP], consumer: 'agent' })
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
    const first = enqueue.prepare({ paths: [ORDINARY, TEMP], consumer: 'agent' })
    const next = enqueue.prepare({ paths: [TEMP], consumer: 'agent' })
    await expect(first).resolves.toMatchObject({
      paths: [ORDINARY],
      failures: [{ commonReason: 'timed-out' }]
    })
    await expect(next).resolves.toEqual({ paths: [COPY], failures: [] })
  })
})
