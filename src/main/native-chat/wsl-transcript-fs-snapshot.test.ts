import {
  ChildProcess,
  type MessageOptions,
  type SendHandle,
  type Serializable
} from 'node:child_process'
import type * as FsPromises from 'node:fs/promises'
import { deserialize, serialize } from 'node:v8'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SnapshotTestState = {
  stopped: boolean
  replacement: boolean
  stalled: Promise<void> | null
}

const state = vi.hoisted((): SnapshotTestState => ({
  stopped: false,
  replacement: false,
  stalled: null
}))
const path = String.raw`\\wsl.localhost\Ubuntu\home\ada\.codex\sessions\session.jsonl`
const original = {
  dev: 9007199254740993n,
  ino: 9007199254740995n,
  size: 8n,
  mtimeNs: 1794160800123456789n,
  ctimeNs: 1794160800987654321n
}
const replacement = {
  dev: 9007199254740993n,
  ino: 9007199254740997n,
  size: 11n,
  mtimeNs: 1794160900123456789n,
  ctimeNs: 1794160900987654321n
}
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) =>
      args[0] === path ? (state.replacement ? replacement : original) : actual.stat(...args),
    open: async (...args: Parameters<typeof actual.open>) => {
      if (args[0] !== path) {
        return actual.open(...args)
      }
      const snapshot = state.replacement ? replacement : original
      return {
        stat: async () => {
          await state.stalled
          return snapshot
        },
        read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
          bytesRead: Buffer.from('original').copy(buffer, offset, position, position + length),
          buffer
        }),
        close: async () => {}
      }
    }
  }
})
vi.mock('./wsl-transcript-running-admission', () => ({
  admitWslTranscriptPath: async () => {
    if (state.stopped) {
      throw new WslTranscriptFsError('unavailable', 'Distro is stopped')
    }
  }
}))

import { WslTranscriptFsProcessOperations } from './wsl-transcript-fs-process-operations'
import { WslTranscriptFsProcessClient } from './wsl-transcript-fs-process-client'
import { WslTranscriptFsError, resetWslTranscriptFsGateForTests } from './wsl-transcript-fs-gate'
import type {
  WslTranscriptFsProcessRequest,
  WslTranscriptFileSnapshot
} from './wsl-transcript-fs-process-protocol'
import { WslJsonlFileHandle } from '../usage/jsonl-file-access'

type SendCallback = (error: Error | null) => void

class FilesystemChild extends ChildProcess {
  private readonly operations = new WslTranscriptFsProcessOperations()
  unref() {
    return this
  }
  kill() {
    return true
  }
  send(
    message: Serializable,
    handleOrCallback?: SendHandle | SendCallback,
    optionsOrCallback?: MessageOptions | SendCallback,
    callback?: SendCallback
  ) {
    const complete =
      typeof handleOrCallback === 'function'
        ? handleOrCallback
        : typeof optionsOrCallback === 'function'
          ? optionsOrCallback
          : callback
    complete?.(null)
    const request: WslTranscriptFsProcessRequest = deserialize(serialize(message))
    void this.operations.execute(request).then(
      (value) => this.emit('message', deserialize(serialize({ id: request.id, ok: true, value }))),
      (error: NodeJS.ErrnoException) =>
        this.emit('message', {
          id: request.id,
          ok: false,
          error: { name: error.name, message: error.message, code: error.code }
        })
    )
    return true
  }
}

let client: WslTranscriptFsProcessClient
let releaseStall: (() => void) | undefined
beforeEach(() => {
  state.stopped = false
  state.replacement = false
  state.stalled = null
  resetWslTranscriptFsGateForTests()
  client = new WslTranscriptFsProcessClient(() => new FilesystemChild())
})
afterEach(() => {
  releaseStall?.()
  releaseStall = undefined
  client.dispose()
  resetWslTranscriptFsGateForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('JSONL snapshots across the WSL filesystem process boundary', () => {
  it('preserves bigint identities and nanoseconds while a handle pins a replaced path', async () => {
    const signal = new AbortController().signal
    const handle = await client.open(path, signal)
    const reader = new WslJsonlFileHandle(path, handle)
    state.replacement = true
    expect(await reader.snapshot()).toEqual(original)
    expect(
      await client.run<WslTranscriptFileSnapshot>({ operation: 'snapshot', path }, signal)
    ).toEqual(replacement)
    const bytes = Buffer.alloc(8)
    expect((await reader.read(bytes, 0, 8, 0)).bytesRead).toBe(8)
    expect(bytes.toString()).toBe('original')
    await reader.close()
  })

  it('refuses snapshots and reads after the distro stops instead of reconnecting its open handle', async () => {
    const handle = await client.open(path, new AbortController().signal)
    const reader = new WslJsonlFileHandle(path, handle)
    state.stopped = true
    await expect(reader.snapshot()).rejects.toMatchObject({
      name: 'WslTranscriptFsError',
      code: 'unavailable'
    })
    await expect(reader.read(Buffer.alloc(8), 0, 8, 0)).rejects.toMatchObject({
      name: 'WslTranscriptFsError',
      code: 'unavailable'
    })
    await reader.close()
  })

  it('rejects a stalled snapshot and invalidates the isolated process handle', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = await client.open(path, new AbortController().signal)
    const reader = new WslJsonlFileHandle(path, handle)
    state.stalled = new Promise<void>((resolve) => {
      releaseStall = resolve
    })
    const rejection = expect(reader.snapshot()).rejects.toMatchObject({
      name: 'WslTranscriptFsError',
      code: 'timeout'
    })
    await vi.advanceTimersByTimeAsync(60_001)
    await rejection
    await expect(client.snapshot(handle, new AbortController().signal)).rejects.toMatchObject({
      code: 'unavailable'
    })
  })
})
