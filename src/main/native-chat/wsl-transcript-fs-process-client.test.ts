import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { Dirent, Stats } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WslTranscriptFsProcessClient } from './wsl-transcript-fs-process-client'
import {
  WSL_TRANSCRIPT_FS_PROCESS_CLOSE_TIMEOUT_MS,
  WSL_TRANSCRIPT_FS_PROCESS_IDLE_REAP_MS
} from './wsl-transcript-fs-process-slot'
import {
  resolveWslTranscriptFsProcessEntryPath,
  wslTranscriptFsProcessForkEnv
} from './wsl-transcript-fs-process-spawn'
import type {
  WslTranscriptFsProcessRequest,
  WslTranscriptFsProcessResponse
} from './wsl-transcript-fs-process-protocol'

class FakeProcess extends EventEmitter {
  readonly sent: WslTranscriptFsProcessRequest[] = []
  readonly kill = vi.fn(() => true)
  readonly unref = vi.fn()
  readonly channel = { unref: vi.fn() }

  send(message: WslTranscriptFsProcessRequest, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(null)
    return true
  }

  respond(response: WslTranscriptFsProcessResponse): void {
    this.emit('message', response)
  }
}

function fakeChild(process: FakeProcess): ChildProcess {
  return process as unknown as ChildProcess
}

describe('WSL transcript filesystem process client', () => {
  it('reuses a healthy process for sequential operations', async () => {
    const child = new FakeProcess()
    const factory = vi.fn(() => fakeChild(child))
    const client = new WslTranscriptFsProcessClient(factory)

    const first = client.run<boolean>(
      { operation: 'access', path: '\\\\wsl.localhost\\Ubuntu\\one' },
      new AbortController().signal
    )
    child.respond({ id: child.sent[0].id, ok: true, value: true })
    await expect(first).resolves.toBe(true)

    const second = client.run<string>(
      {
        operation: 'readfile',
        path: '\\\\wsl.localhost\\Ubuntu\\two',
        encoding: 'utf8'
      },
      new AbortController().signal
    )
    child.respond({ id: child.sent[1].id, ok: true, value: 'body' })

    await expect(second).resolves.toBe('body')
    expect(factory).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
    client.dispose()
  })

  it('kills an aborted process and uses a replacement for later work', async () => {
    const firstChild = new FakeProcess()
    const replacement = new FakeProcess()
    const factory = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(fakeChild(firstChild))
      .mockReturnValueOnce(fakeChild(replacement))
    const client = new WslTranscriptFsProcessClient(factory)
    const controller = new AbortController()
    const reason = new Error('deadline expired')

    const stalled = client.run(
      { operation: 'stat', path: '\\\\wsl.localhost\\Ubuntu\\stalled' },
      controller.signal
    )
    controller.abort(reason)

    await expect(stalled).rejects.toBe(reason)
    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')

    const later = client.run<boolean>(
      { operation: 'access', path: '\\\\wsl.localhost\\Fedora\\later' },
      new AbortController().signal
    )
    replacement.respond({ id: replacement.sent[0].id, ok: true, value: true })
    await expect(later).resolves.toBe(true)
    expect(factory).toHaveBeenCalledTimes(2)
    client.dispose()
  })

  it('multiplexes sequential opened handles through one process until close', async () => {
    const owner = new FakeProcess()
    const factory = vi.fn(() => fakeChild(owner))
    const client = new WslTranscriptFsProcessClient(factory)
    const signal = new AbortController().signal

    const opening = client.open('\\\\wsl.localhost\\Ubuntu\\transcript', signal)
    owner.respond({ id: owner.sent[0].id, ok: true, value: 41 })
    const handle = await opening

    const secondOpening = client.open('\\\\wsl.localhost\\Ubuntu\\second', signal)
    owner.respond({ id: owner.sent[1].id, ok: true, value: 42 })
    const secondHandle = await secondOpening

    const reading = client.read(handle, 8, 4, signal)
    expect(owner.sent[2]).toMatchObject({ operation: 'read', handleId: 41, position: 8 })
    owner.respond({ id: owner.sent[2].id, ok: true, value: Buffer.from('old!') })
    await expect(reading).resolves.toEqual(Buffer.from('old!'))

    const secondReading = client.read(secondHandle, 0, 3, signal)
    expect(owner.sent[3]).toMatchObject({ operation: 'read', handleId: 42, position: 0 })
    owner.respond({ id: owner.sent[3].id, ok: true, value: Buffer.from('new') })
    await expect(secondReading).resolves.toEqual(Buffer.from('new'))

    const closing = client.close(handle)
    expect(owner.sent[4]).toMatchObject({ operation: 'close', handleId: 41 })
    owner.respond({ id: owner.sent[4].id, ok: true, value: true })
    await expect(closing).resolves.toBeUndefined()

    const secondClosing = client.close(secondHandle)
    expect(owner.sent[5]).toMatchObject({ operation: 'close', handleId: 42 })
    owner.respond({ id: owner.sent[5].id, ok: true, value: true })
    await expect(secondClosing).resolves.toBeUndefined()

    const later = client.run<boolean>(
      { operation: 'access', path: '\\\\wsl.localhost\\Ubuntu\\later' },
      signal
    )
    owner.respond({ id: owner.sent[6].id, ok: true, value: true })
    await expect(later).resolves.toBe(true)
    expect(factory).toHaveBeenCalledOnce()
    client.dispose()
  })

  it('queues concurrent opens instead of creating another helper', async () => {
    const child = new FakeProcess()
    const factory = vi.fn(() => fakeChild(child))
    const client = new WslTranscriptFsProcessClient(factory)
    const signal = new AbortController().signal

    const firstOpening = client.open('\\\\wsl.localhost\\Ubuntu\\first', signal)
    const secondOpening = client.open('\\\\wsl.localhost\\Ubuntu\\second', signal)
    expect(factory).toHaveBeenCalledOnce()
    expect(child.sent).toHaveLength(1)

    child.respond({ id: child.sent[0].id, ok: true, value: 1 })
    const firstHandle = await firstOpening
    await vi.waitFor(() => expect(child.sent).toHaveLength(2))
    child.respond({ id: child.sent[1].id, ok: true, value: 2 })
    const secondHandle = await secondOpening

    const firstClose = client.close(firstHandle)
    child.respond({ id: child.sent[2].id, ok: true, value: true })
    await firstClose
    const secondClose = client.close(secondHandle)
    child.respond({ id: child.sent[3].id, ok: true, value: true })
    await secondClose

    expect(factory).toHaveBeenCalledOnce()
    client.dispose()
  })

  it('returns a granted slot when its queued caller aborts before sending', async () => {
    const child = new FakeProcess()
    const client = new WslTranscriptFsProcessClient(() => fakeChild(child))
    const controller = new AbortController()
    const signal = new AbortController().signal

    const first = client.run<boolean>({ operation: 'access', path: 'first' }, signal)
    const aborted = client.run<boolean>({ operation: 'access', path: 'aborted' }, controller.signal)
    child.respond({ id: child.sent[0].id, ok: true, value: true })
    controller.abort(new Error('cancelled after grant'))

    await expect(first).resolves.toBe(true)
    await expect(aborted).rejects.toThrow('cancelled after grant')
    const later = client.run<boolean>({ operation: 'access', path: 'later' }, signal)
    expect(child.sent).toHaveLength(2)
    child.respond({ id: child.sent[1].id, ok: true, value: true })
    await expect(later).resolves.toBe(true)
    client.dispose()
  })

  it('rejects a granted request if the helper exits before it sends', async () => {
    const child = new FakeProcess()
    const replacement = new FakeProcess()
    const factory = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(fakeChild(child))
      .mockReturnValueOnce(fakeChild(replacement))
    const client = new WslTranscriptFsProcessClient(factory)
    const signal = new AbortController().signal

    const first = client.run<boolean>({ operation: 'access', path: 'first' }, signal)
    const stranded = client.run<boolean>({ operation: 'access', path: 'stranded' }, signal)
    child.respond({ id: child.sent[0].id, ok: true, value: true })
    child.emit('disconnect')

    await expect(first).resolves.toBe(true)
    await expect(stranded).rejects.toMatchObject({ code: 'unavailable' })
    expect(replacement.sent).toHaveLength(0)
    client.dispose()
  })

  // Why: the gate waiter can give up mid-read and the caller's finally closes
  // right away; a refused close would strand the pinned slot (and its child)
  // forever once that read settles.
  it('defers a close issued while a read is in flight instead of stranding the slot', async () => {
    const owner = new FakeProcess()
    const factory = vi.fn(() => fakeChild(owner))
    const client = new WslTranscriptFsProcessClient(factory)
    const signal = new AbortController().signal

    const opening = client.open('\\\\wsl.localhost\\Ubuntu\\transcript', signal)
    owner.respond({ id: owner.sent[0].id, ok: true, value: 5 })
    const handle = await opening

    const reading = client.read(handle, 0, 4, signal)
    const closing = client.close(handle)
    // The close waits for the in-flight read; nothing extra was sent yet.
    expect(owner.sent).toHaveLength(2)

    owner.respond({ id: owner.sent[1].id, ok: true, value: Buffer.from('data') })
    await expect(reading).resolves.toEqual(Buffer.from('data'))
    await vi.waitFor(() => expect(owner.sent).toHaveLength(3))
    expect(owner.sent[2]).toMatchObject({ operation: 'close', handleId: 5 })
    owner.respond({ id: owner.sent[2].id, ok: true, value: true })
    await expect(closing).resolves.toBeUndefined()

    // The slot returned to the pool instead of leaking pinned.
    const later = client.run<boolean>(
      { operation: 'access', path: '\\\\wsl.localhost\\Ubuntu\\after-close' },
      signal
    )
    owner.respond({ id: owner.sent[3].id, ok: true, value: true })
    await expect(later).resolves.toBe(true)
    expect(factory).toHaveBeenCalledOnce()
    expect(owner.kill).not.toHaveBeenCalled()
    client.dispose()
  })

  it('invalidates lane handles and serves queued work from a replacement', async () => {
    const owner = new FakeProcess()
    const healthy = new FakeProcess()
    const factory = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(fakeChild(owner))
      .mockReturnValueOnce(fakeChild(healthy))
    const client = new WslTranscriptFsProcessClient(factory)
    const opening = client.open(
      '\\\\wsl.localhost\\Ubuntu\\transcript',
      new AbortController().signal
    )
    owner.respond({ id: owner.sent[0].id, ok: true, value: 9 })
    const handle = await opening
    const controller = new AbortController()
    const reason = new Error('read deadline')

    const stalled = client.read(handle, 0, 1, controller.signal)
    const other = client.run<boolean>(
      { operation: 'access', path: '\\\\wsl.localhost\\Fedora\\healthy' },
      new AbortController().signal
    )
    controller.abort(reason)

    await expect(stalled).rejects.toBe(reason)
    await vi.waitFor(() => expect(healthy.sent).toHaveLength(1))
    healthy.respond({ id: healthy.sent[0].id, ok: true, value: true })
    await expect(other).resolves.toBe(true)
    // The handle died with its killed process — a transport condition, so later
    // reads surface as a retryable refusal rather than a caller EBADF bug.
    await expect(client.read(handle, 0, 1, new AbortController().signal)).rejects.toMatchObject({
      name: 'WslTranscriptFsError',
      code: 'unavailable'
    })
    expect(owner.kill).toHaveBeenCalledWith('SIGKILL')
    expect(healthy.kill).not.toHaveBeenCalled()

    const later = client.run<boolean>(
      { operation: 'access', path: '\\\\wsl.localhost\\Fedora\\later' },
      new AbortController().signal
    )
    healthy.respond({ id: healthy.sent[1].id, ok: true, value: true })
    await expect(later).resolves.toBe(true)
    client.dispose()
  })

  it('retires a process whose handle close does not settle', async () => {
    vi.useFakeTimers()
    const owner = new FakeProcess()
    const healthy = new FakeProcess()
    const factory = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(fakeChild(owner))
      .mockReturnValueOnce(fakeChild(healthy))
    const client = new WslTranscriptFsProcessClient(factory)
    try {
      const opening = client.open(
        '\\\\wsl.localhost\\Ubuntu\\transcript',
        new AbortController().signal
      )
      owner.respond({ id: owner.sent[0].id, ok: true, value: 12 })
      const handle = await opening
      const closing = client.close(handle)
      const closeFailure = expect(closing).rejects.toThrow('close timed out')

      const unrelated = client.run<boolean>(
        { operation: 'access', path: '\\\\wsl.localhost\\Fedora\\healthy' },
        new AbortController().signal
      )

      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_PROCESS_CLOSE_TIMEOUT_MS)
      await closeFailure
      await vi.waitFor(() => expect(healthy.sent).toHaveLength(1))
      healthy.respond({ id: healthy.sent[0].id, ok: true, value: true })
      await expect(unrelated).resolves.toBe(true)
      expect(owner.kill).toHaveBeenCalledWith('SIGKILL')
      expect(healthy.kill).not.toHaveBeenCalled()
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  })

  it('reaps an idle process after the idle deadline and forks a fresh one later', async () => {
    vi.useFakeTimers()
    const child = new FakeProcess()
    const replacement = new FakeProcess()
    const factory = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(fakeChild(child))
      .mockReturnValueOnce(fakeChild(replacement))
    const client = new WslTranscriptFsProcessClient(factory)
    try {
      const first = client.run<boolean>(
        { operation: 'access', path: '\\\\wsl.localhost\\Ubuntu\\one' },
        new AbortController().signal
      )
      child.respond({ id: child.sent[0].id, ok: true, value: true })
      await expect(first).resolves.toBe(true)

      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_PROCESS_IDLE_REAP_MS)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')

      const later = client.run<boolean>(
        { operation: 'access', path: '\\\\wsl.localhost\\Ubuntu\\two' },
        new AbortController().signal
      )
      replacement.respond({ id: replacement.sent[0].id, ok: true, value: true })
      await expect(later).resolves.toBe(true)
      expect(factory).toHaveBeenCalledTimes(2)
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  })

  it('surfaces child transport faults as unavailable gate refusals', async () => {
    const child = new FakeProcess()
    const client = new WslTranscriptFsProcessClient(() => fakeChild(child))
    const pending = client.run(
      { operation: 'access', path: '\\\\wsl.localhost\\Ubuntu\\dead' },
      new AbortController().signal
    )
    child.emit('exit', 9)
    await expect(pending).rejects.toMatchObject({
      name: 'WslTranscriptFsError',
      code: 'unavailable'
    })
    client.dispose()
  })

  it('names the killing signal instead of a null exit code', async () => {
    const child = new FakeProcess()
    const client = new WslTranscriptFsProcessClient(() => fakeChild(child))
    const pending = client.run(
      { operation: 'access', path: '\\\\wsl.localhost\\Ubuntu\\killed' },
      new AbortController().signal
    )
    // A signal-terminated child reports code null; the message must carry the signal.
    child.emit('exit', null, 'SIGKILL')
    await expect(pending).rejects.toMatchObject({
      name: 'WslTranscriptFsError',
      code: 'unavailable',
      message: expect.stringContaining('exited (SIGKILL)')
    })
    client.dispose()
  })

  it('reconstructs filesystem errors with their Node error code', async () => {
    const child = new FakeProcess()
    const client = new WslTranscriptFsProcessClient(() => fakeChild(child))
    const pending = client.run(
      { operation: 'stat', path: '\\\\wsl.localhost\\Ubuntu\\missing' },
      new AbortController().signal
    )

    child.respond({
      id: child.sent[0].id,
      ok: false,
      error: {
        name: 'Error',
        message: 'not found',
        code: 'ENOENT',
        syscall: 'stat',
        path: '\\\\wsl.localhost\\Ubuntu\\missing'
      }
    })

    await expect(pending).rejects.toMatchObject({
      message: 'not found',
      code: 'ENOENT',
      syscall: 'stat'
    })
    client.dispose()
  })

  it('restores Stats and Dirent methods after IPC serialization', async () => {
    const child = new FakeProcess()
    const client = new WslTranscriptFsProcessClient(() => fakeChild(child))
    const stats = client.run<Stats>(
      { operation: 'stat', path: '\\\\wsl.localhost\\Ubuntu\\file' },
      new AbortController().signal
    )
    child.respond({
      id: child.sent[0].id,
      ok: true,
      value: { mode: 0o100644, size: 12, mtime: new Date(0) }
    })

    expect((await stats).isFile()).toBe(true)

    const entries = client.run<Dirent[]>(
      { operation: 'readdir', path: '\\\\wsl.localhost\\Ubuntu\\dir' },
      new AbortController().signal
    )
    child.respond({
      id: child.sent[1].id,
      ok: true,
      value: [
        {
          name: 'child',
          parentPath: '\\\\wsl.localhost\\Ubuntu\\dir',
          isBlockDevice: false,
          isCharacterDevice: false,
          isDirectory: false,
          isFIFO: false,
          isFile: true,
          isSocket: false,
          isSymbolicLink: false
        }
      ]
    })

    expect((await entries)[0].isFile()).toBe(true)
    client.dispose()
  })
})

describe('WSL transcript filesystem process entry resolution', () => {
  it('prefers the unpacked sibling for a packaged main bundle', () => {
    const exists = vi.fn((path: string) => path.includes('app.asar.unpacked'))
    const moduleDir = join('root', 'resources', 'app.asar', 'out', 'main')

    expect(
      resolveWslTranscriptFsProcessEntryPath(moduleDir, join('root', 'resources'), exists)
    ).toBe(
      join(moduleDir.replace('app.asar', 'app.asar.unpacked'), 'wsl-transcript-fs-process-entry.js')
    )
  })

  // Why: this module compiles into a shared rollup chunk under out/main/chunks,
  // and the scanner service child has no process.resourcesPath to fall back on.
  it('resolves the entry from a shared chunk one level below out/main', () => {
    const moduleDir = join('root', 'out', 'main', 'chunks')
    const target = join('root', 'out', 'main', 'wsl-transcript-fs-process-entry.js')
    const exists = vi.fn((path: string) => path === target)

    expect(resolveWslTranscriptFsProcessEntryPath(moduleDir, undefined, exists)).toBe(target)
  })

  it('excludes ambient NODE_OPTIONS and secrets from the fork env', () => {
    const env = wslTranscriptFsProcessForkEnv(
      {
        PATH: 'C:\\bin',
        SYSTEMROOT: 'C:\\WINDOWS',
        NODE_OPTIONS: '--inspect-brk',
        SECRET_TOKEN: 'shh'
      },
      'win32'
    )

    expect(env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      PATH: 'C:\\bin',
      // The shared allowlist emits the canonical Windows casing.
      SystemRoot: 'C:\\WINDOWS'
    })
    expect(env).not.toHaveProperty('NODE_OPTIONS')
    expect(env).not.toHaveProperty('SECRET_TOKEN')
  })
})
