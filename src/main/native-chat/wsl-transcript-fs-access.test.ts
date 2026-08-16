import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsModule from 'node:fs'
import type * as NodeFsPromisesModule from 'node:fs/promises'
import type * as GateModule from './wsl-transcript-fs-gate'

const UNC_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\a.jsonl'
const OTHER_DISTRO_UNC_PATH = '\\\\wsl.localhost\\Debian\\home\\ada\\.codex\\sessions\\a.jsonl'
const LEGACY_UNC_PATH = '\\\\wsl$\\Ubuntu\\home\\ada\\.codex\\sessions\\a.jsonl'
const WINDOWS_PATH = 'C:\\Users\\ada\\.codex\\sessions\\a.jsonl'
const POSIX_PATH = '/home/ada/.codex/sessions/a.jsonl'

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  lstat: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  open: vi.fn(),
  createReadStream: vi.fn(),
  runTask: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsModule>()),
  createReadStream: mocks.createReadStream
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  stat: mocks.stat,
  lstat: mocks.lstat,
  readdir: mocks.readdir,
  readFile: mocks.readFile,
  open: mocks.open
}))

vi.mock('./wsl-transcript-fs-gate', async (importOriginal) => {
  const original = await importOriginal<typeof GateModule>()
  mocks.runTask.mockImplementation(original.runWslTranscriptFsTask)
  return { ...original, runWslTranscriptFsTask: mocks.runTask }
})

import {
  closeTranscriptHandle,
  openTranscriptReadStream,
  readTranscriptSlice,
  wslGatedLstat,
  wslGatedOpen,
  wslGatedRead,
  wslGatedReaddir,
  wslGatedReadFile,
  wslGatedStat,
  WSL_TRANSCRIPT_READ_CHUNK_BYTES
} from './wsl-transcript-fs-access'
import {
  resetWslTranscriptFsGateForTests,
  WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS,
  WslTranscriptFsError
} from './wsl-transcript-fs-gate'

function fakeHandle() {
  return { read: vi.fn(), close: vi.fn(async () => {}) }
}

beforeEach(() => {
  // The gate mock delegates to the real implementation, so its module state
  // survives between cases — a case that leaves a task stalled would otherwise
  // mark that route stuck and fast-fail every later case on it.
  resetWslTranscriptFsGateForTests()
  // runTask keeps the real gate implementation installed by the mock factory;
  // only its call log is cleared.
  mocks.runTask.mockClear()
  for (const [name, mock] of Object.entries(mocks)) {
    if (name !== 'runTask') {
      mock.mockReset()
    }
  }
})

describe('transcript filesystem accessor off WSL UNC', () => {
  it.each([
    ['a posix path', POSIX_PATH],
    ['a Windows drive path', WINDOWS_PATH]
  ])('never enters the gate for %s', async (_label, path) => {
    mocks.stat.mockResolvedValue({ size: 1 })
    mocks.lstat.mockResolvedValue({ size: 1 })
    mocks.readdir.mockResolvedValue([])
    mocks.readFile.mockResolvedValue('body')
    const handle = fakeHandle()
    handle.read.mockResolvedValue({ bytesRead: 0, buffer: Buffer.alloc(0) })
    mocks.open.mockResolvedValue(handle)
    mocks.createReadStream.mockReturnValue('raw-stream')

    await wslGatedStat(path, 'exact')
    await wslGatedLstat(path, 'scan')
    await wslGatedReaddir(path, 'scan')
    await wslGatedReadFile(path, 'utf-8', 'scan')
    const opened = await wslGatedOpen(path, 'exact')
    await wslGatedRead(opened, path, Buffer.alloc(1), 0, 1, 0, 'exact')
    const stream = openTranscriptReadStream(path, { encoding: 'utf-8' }, 'scan')

    expect(mocks.runTask).not.toHaveBeenCalled()
    expect(mocks.stat).toHaveBeenCalledWith(path)
    expect(mocks.readdir).toHaveBeenCalledWith(path, { withFileTypes: true })
    expect(mocks.readFile).toHaveBeenCalledWith(path, 'utf-8')
    expect(mocks.open).toHaveBeenCalledWith(path, 'r')
    // Off UNC the raw stream is handed back verbatim, encoding included.
    expect(stream).toBe('raw-stream')
    expect(mocks.createReadStream).toHaveBeenCalledWith(path, {
      encoding: 'utf-8',
      signal: undefined
    })
  })

  it('forwards the caller signal so the local stream honours cancellation', () => {
    mocks.createReadStream.mockReturnValue('raw-stream')
    const controller = new AbortController()

    openTranscriptReadStream(POSIX_PATH, { start: 4 }, 'exact', controller.signal)

    expect(mocks.createReadStream).toHaveBeenCalledWith(POSIX_PATH, {
      start: 4,
      signal: controller.signal
    })
  })
})

describe('transcript filesystem accessor on WSL UNC', () => {
  it.each([
    ['wsl.localhost', UNC_PATH],
    ['wsl$', LEGACY_UNC_PATH]
  ])('routes %s paths through the gate', async (_label, path) => {
    mocks.stat.mockResolvedValue({ size: 7 })
    mocks.lstat.mockResolvedValue({ size: 7 })
    mocks.readdir.mockResolvedValue([])
    mocks.readFile.mockResolvedValue('body')

    await wslGatedStat(path, 'exact')
    await wslGatedLstat(path, 'scan')
    await wslGatedReaddir(path, 'scan')
    await wslGatedReadFile(path, 'utf-8', 'scan')

    expect(mocks.runTask.mock.calls.map(([options]) => options.operation)).toEqual([
      'stat',
      'lstat',
      'readdir',
      'readfile'
    ])
  })

  it('opts positional reads and opens out of coalescing', async () => {
    const handle = fakeHandle()
    handle.read.mockResolvedValue({ bytesRead: 1, buffer: Buffer.alloc(1) })
    mocks.open.mockResolvedValue(handle)

    const opened = await wslGatedOpen(UNC_PATH, 'exact')
    await wslGatedRead(opened, UNC_PATH, Buffer.alloc(1), 0, 1, 0, 'exact')

    for (const call of mocks.runTask.mock.calls) {
      expect(call[0]).toMatchObject({ dedupe: false })
    }
  })

  it('reads a slice and closes the handle even when the read rejects', async () => {
    const handle = fakeHandle()
    handle.read.mockRejectedValue(new Error('EIO'))
    mocks.open.mockResolvedValue(handle)

    await expect(readTranscriptSlice(UNC_PATH, 4, 8, 'scan')).rejects.toThrow('EIO')
    expect(handle.close).toHaveBeenCalledTimes(1)
  })

  it('yields Buffer chunks and closes the handle when the consumer destroys the stream', async () => {
    const handle = fakeHandle()
    handle.read.mockImplementation(
      async (buffer: Buffer, offset: number, length: number, position: number) => {
        const body = Buffer.from('{"a":1}\n{"b":2}\n')
        const slice = body.subarray(position, Math.min(position + length, body.length))
        slice.copy(buffer, offset)
        return { bytesRead: slice.length, buffer }
      }
    )
    mocks.open.mockResolvedValue(handle)

    const stream = openTranscriptReadStream(UNC_PATH, {}, 'exact')
    const chunks: unknown[] = []
    for await (const chunk of stream) {
      chunks.push(chunk)
      break
    }
    stream.destroy()
    await new Promise((resolve) => setImmediate(resolve))

    expect(chunks).toHaveLength(1)
    expect(Buffer.isBuffer(chunks[0])).toBe(true)
    expect((chunks[0] as Buffer).toString('utf-8')).toBe('{"a":1}\n{"b":2}\n')
    expect(handle.close).toHaveBeenCalledTimes(1)
  })

  it('swallows close failures so teardown never rejects', async () => {
    const handle = fakeHandle()
    handle.close.mockRejectedValue(new Error('stalled close'))
    await expect(closeTranscriptHandle(handle as never, UNC_PATH)).resolves.toBeUndefined()
    await new Promise((resolve) => setImmediate(resolve))
  })

  it('drains handle closes one at a time so teardown cannot flood the thread pool', async () => {
    let releaseFirst: (() => void) | undefined
    const first = fakeHandle()
    first.close.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    )
    const second = fakeHandle()

    await closeTranscriptHandle(first as never, UNC_PATH)
    await closeTranscriptHandle(second as never, UNC_PATH)
    await new Promise((resolve) => setImmediate(resolve))

    // A blocked uv_fs_close holds a libuv thread the gate cannot see, so the
    // second one must wait rather than occupy a thread of its own.
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()

    releaseFirst?.()
    await new Promise((resolve) => setImmediate(resolve))
    expect(second.close).toHaveBeenCalledTimes(1)
  })

  it('keeps a blocked close on one distro from stranding teardown on another', async () => {
    let releaseStuck: (() => void) | undefined
    const stuck = fakeHandle()
    stuck.close.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseStuck = resolve
      })
    )
    const healthy = fakeHandle()

    try {
      await closeTranscriptHandle(stuck as never, UNC_PATH)
      await closeTranscriptHandle(healthy as never, OTHER_DISTRO_UNC_PATH)
      await new Promise((resolve) => setImmediate(resolve))

      // A close that never settles on a stalled mount would hold a shared lane
      // for the process lifetime, leaking every later descriptor with it.
      expect(stuck.close).toHaveBeenCalledTimes(1)
      expect(healthy.close).toHaveBeenCalledTimes(1)
    } finally {
      releaseStuck?.()
      await new Promise((resolve) => setImmediate(resolve))
    }
  })

  it.each([
    ['stat', wslGatedStat, mocks.stat],
    ['lstat', wslGatedLstat, mocks.lstat]
  ])(
    'detaches a cancelled %s waiter without waiting out the deadline',
    async (_op, gated, mock) => {
      let release: (() => void) | undefined
      mock.mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve({ size: 0 })
        })
      )
      try {
        const controller = new AbortController()
        const reason = new Error('unsubscribed')
        const pending = gated(UNC_PATH, 'exact', controller.signal)
        const settled = pending.then(
          () => 'resolved',
          (error: unknown) => error
        )
        // Let the gate admit and start the syscall, so this covers the waiter on a
        // RUNNING unabortable call rather than a still-queued one.
        await new Promise((resolve) => setImmediate(resolve))
        expect(mock).toHaveBeenCalledTimes(1)

        controller.abort(reason)

        // No timer advance: the waiter must be gone the moment the caller cancels,
        // not 30s later when its deadline fires.
        await expect(settled).resolves.toBe(reason)
      } finally {
        release?.()
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
  )

  it('closes an abandoned open whose syscall lands after the caller gave up', async () => {
    vi.useFakeTimers()
    let release: ((handle: unknown) => void) | undefined
    mocks.open.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )
    try {
      const handle = fakeHandle()
      const refused = wslGatedOpen(UNC_PATH, 'exact').catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS + 1)
      await expect(refused).resolves.toBeInstanceOf(WslTranscriptFsError)

      release?.(handle)
      await vi.advanceTimersByTimeAsync(0)

      // Nobody received the handle, so the gate owns closing it.
      expect(handle.close).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('transcript handle close off WSL UNC', () => {
  it('awaits teardown and surfaces the failure, as the raw close did', async () => {
    const handle = fakeHandle()
    let closed = false
    handle.close.mockImplementation(async () => {
      await new Promise((resolve) => setImmediate(resolve))
      closed = true
    })

    await closeTranscriptHandle(handle as never, POSIX_PATH)
    expect(closed).toBe(true)

    handle.close.mockRejectedValue(new Error('EIO on close'))
    await expect(closeTranscriptHandle(handle as never, WINDOWS_PATH)).rejects.toThrow(
      'EIO on close'
    )
  })
})

describe('per-chunk admission', () => {
  it('carries a codepoint straddling the 1 MiB chunk boundary across chunks', async () => {
    const emoji = Buffer.from('😀', 'utf8')
    // Two of the emoji's four bytes land in chunk 1, two in chunk 2 — derived
    // from the production constant so the fixture cannot drift off the boundary.
    const body = Buffer.concat([
      Buffer.alloc(WSL_TRANSCRIPT_READ_CHUNK_BYTES - 2, 0x61),
      emoji,
      Buffer.from('tail\n', 'utf8')
    ])
    const handle = fakeHandle()
    handle.read.mockImplementation(
      async (buffer: Buffer, offset: number, length: number, position: number) => {
        const slice = body.subarray(position, Math.min(position + length, body.length))
        slice.copy(buffer, offset)
        return { bytesRead: slice.length, buffer }
      }
    )
    mocks.open.mockResolvedValue(handle)

    const stream = openTranscriptReadStream(UNC_PATH, { encoding: 'utf-8' }, 'exact')
    let decoded = ''
    for await (const chunk of stream) {
      expect(typeof chunk).toBe('string')
      decoded += chunk as string
    }

    expect(decoded).not.toContain('�')
    expect(decoded).toBe(body.toString('utf8'))
    expect(handle.read.mock.calls.length).toBeGreaterThan(1)
  })

  it('surfaces a gate refusal mid-stream as an error event', async () => {
    vi.useFakeTimers()
    try {
      let served = 0
      const handle = fakeHandle()
      handle.read.mockImplementation((buffer: Buffer) => {
        if (served++ === 0) {
          buffer.write('x')
          return Promise.resolve({ bytesRead: 1, buffer })
        }
        return new Promise(() => {})
      })
      mocks.open.mockResolvedValue(handle)

      const stream = openTranscriptReadStream(UNC_PATH, {}, 'exact')
      const drained = (async () => {
        for await (const chunk of stream) {
          void chunk
        }
      })()
      const settled = drained.then(
        () => null,
        (error: unknown) => error
      )
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS + 1)

      await expect(settled).resolves.toBeInstanceOf(WslTranscriptFsError)
      expect(handle.close).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
