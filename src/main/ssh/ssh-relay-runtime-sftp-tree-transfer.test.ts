import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { publishSshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry'
import { createSshRelayArtifactCacheEntryFixture } from './ssh-relay-artifact-cache-entry-fixture'
import {
  acquireSshRelayArtifactCacheInUseLease,
  type SshRelayArtifactCacheInUseLease
} from './ssh-relay-artifact-cache-in-use-lease'
import { scanSshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-scan'
import {
  transferSshRelayRuntimeTreeViaSftp,
  type SshRelayRuntimeSftpTreeSession
} from './ssh-relay-runtime-sftp-tree-transfer'
import { createSshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-tree'

type Callback = (error?: Error) => void

const cleanupRoots = new Set<string>()
const cleanupLeases = new Set<SshRelayArtifactCacheInUseLease>()

async function treeFixture(os: 'linux' | 'win32' = 'linux') {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-sftp-tree-'))
  cleanupRoots.add(root)
  const inputRoot = join(root, 'input')
  await mkdir(inputRoot)
  const fixture = await createSshRelayArtifactCacheEntryFixture({ root: inputRoot, os })
  const cacheRoot = join(root, 'cache')
  const entry = await publishSshRelayArtifactCacheEntry({
    cacheRoot,
    artifact: fixture.artifact,
    archivePath: fixture.archivePath
  })
  const lease = await acquireSshRelayArtifactCacheInUseLease({ cacheRoot, entry })
  cleanupLeases.add(lease)
  const source = createSshRelayRuntimeSourceTree({
    kind: 'ready',
    source: 'cache',
    artifact: fixture.artifact,
    entry,
    lease
  })
  return scanSshRelayRuntimeSourceTree(source, new AbortController().signal)
}

function sftpError(message: string, code?: number): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code })
}

function createSession(): {
  session: SshRelayRuntimeSftpTreeSession
  events: string[]
  files: Map<string, Buffer>
  modes: Map<string, number>
} {
  const events: string[] = []
  const files = new Map<string, Buffer>()
  const modes = new Map<string, number>()
  const handles = new Map<string, string>()
  let nextHandle = 0
  const operations = {
    mkdir: vi.fn((path: string, attributes: { mode: number }, callback: Callback) => {
      events.push(`mkdir:${path}:${attributes.mode.toString(8)}`)
      callback()
    }),
    open: vi.fn(
      (
        path: string,
        _flags: 'wx',
        attributes: { mode: number },
        callback: (error: Error | undefined, handle: Buffer) => void
      ) => {
        events.push(`open:${path}`)
        const handle = Buffer.from(`handle-${nextHandle++}`)
        handles.set(handle.toString(), path)
        files.set(path, Buffer.alloc(0))
        modes.set(path, attributes.mode)
        callback(undefined, handle)
      }
    ),
    write: vi.fn(
      (
        handle: Buffer,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
        callback: Callback
      ) => {
        const path = handles.get(handle.toString()) as string
        events.push(`write:${path}`)
        const current = files.get(path) ?? Buffer.alloc(0)
        const next = Buffer.alloc(Math.max(current.length, position + length))
        current.copy(next)
        buffer.copy(next, position, offset, offset + length)
        files.set(path, next)
        callback()
      }
    ),
    fchmod: vi.fn((handle: Buffer, mode: number, callback: Callback) => {
      const path = handles.get(handle.toString()) as string
      events.push(`fchmod:${path}`)
      modes.set(path, mode)
      callback()
    }),
    fstat: vi.fn(
      (handle: Buffer, callback: (error: Error | undefined, value: { mode: number }) => void) => {
        const path = handles.get(handle.toString()) as string
        callback(undefined, { mode: modes.get(path) as number })
      }
    ),
    close: vi.fn((handle: Buffer, callback: Callback) => {
      events.push(`close-file:${handles.get(handle.toString())}`)
      callback()
    }),
    unlink: vi.fn((path: string, callback: Callback) => {
      events.push(`unlink:${path}`)
      if (!files.delete(path)) {
        callback(sftpError('missing', 2))
        return
      }
      callback()
    }),
    rmdir: vi.fn((path: string, callback: Callback) => {
      events.push(`rmdir:${path}`)
      callback()
    })
  }
  const session = {
    operations,
    close: vi.fn(async () => {
      events.push('close-session')
    })
  } as unknown as SshRelayRuntimeSftpTreeSession
  return { session, events, files, modes }
}

afterEach(async () => {
  await Promise.all([...cleanupLeases].map((lease) => lease.release().catch(() => {})))
  cleanupLeases.clear()
  await Promise.all([...cleanupRoots].map((root) => rm(root, { recursive: true, force: true })))
  cleanupRoots.clear()
})

describe('SSH relay runtime SFTP tree transfer', () => {
  it('creates the exclusive POSIX tree, streams exact bytes, and awaits session close', async () => {
    const tree = await treeFixture()
    const { session, events, files, modes } = createSession()
    let releaseClose: (() => void) | undefined
    vi.mocked(session.close).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = () => {
            events.push('close-session')
            resolve()
          }
        })
    )
    const progress: unknown[] = []
    const transfer = transferSshRelayRuntimeTreeViaSftp({
      tree,
      remoteStagingRoot: '/home/orca/.staging/content',
      enforcePosixMode: true,
      maximumConcurrency: 2,
      signal: new AbortController().signal,
      openSession: async () => session,
      onProgress: (value) => progress.push(value)
    })

    await vi.waitFor(() => expect(session.close).toHaveBeenCalledOnce())
    expect(await Promise.race([transfer.then(() => 'settled'), Promise.resolve('pending')])).toBe(
      'pending'
    )
    releaseClose?.()
    const result = await transfer

    expect(result).toMatchObject({
      remoteStagingRoot: '/home/orca/.staging/content',
      filesCompleted: tree.fileCount,
      bytesTransferred: tree.expandedBytes
    })
    expect(events[0]).toBe('mkdir:/home/orca/.staging/content:700')
    expect(events.findIndex((event) => event.startsWith('open:'))).toBeGreaterThan(
      events.findLastIndex((event) => event.startsWith('mkdir:'))
    )
    expect(files.size).toBe(tree.fileCount)
    expect(
      tree.files.every(
        (file) => modes.get(`/home/orca/.staging/content/${file.path}`) === file.mode
      )
    ).toBe(true)
    expect(progress.length).toBeGreaterThan(0)
    expect(events.at(-1)).toBe('close-session')
  })

  it('uses slash-safe Windows paths and explicitly skips POSIX mode repair', async () => {
    const tree = await treeFixture('win32')
    const { session, events } = createSession()

    await transferSshRelayRuntimeTreeViaSftp({
      tree,
      remoteStagingRoot: 'C:\\Users\\orca\\staging\\content',
      enforcePosixMode: false,
      signal: new AbortController().signal,
      openSession: async () => session
    })

    expect(events).toContain('mkdir:C:/Users/orca/staging/content:700')
    expect(events.some((event) => event.startsWith('open:C:/Users/orca/staging/content/'))).toBe(
      true
    )
    expect(session.operations.fchmod).not.toHaveBeenCalled()
  })

  it('never exceeds four concurrently open SFTP files', async () => {
    const tree = await treeFixture()
    const { session } = createSession()
    let active = 0
    let peak = 0
    let releaseWrites: (() => void) | undefined
    const gate = new Promise<void>((resolve) => (releaseWrites = resolve))
    vi.mocked(session.operations.write).mockImplementation(
      (_handle, _buffer, _offset, _length, _position, callback) => {
        active += 1
        peak = Math.max(peak, active)
        if (active === Math.min(4, tree.fileCount)) {
          releaseWrites?.()
        }
        void gate.then(() => {
          active -= 1
          callback()
        })
      }
    )

    await transferSshRelayRuntimeTreeViaSftp({
      tree,
      remoteStagingRoot: '/staging/content',
      enforcePosixMode: true,
      maximumConcurrency: 4,
      signal: new AbortController().signal,
      openSession: async () => session
    })
    expect(peak).toBe(Math.min(4, tree.fileCount))
  })

  it('does not remove a pre-existing root when exclusive creation fails', async () => {
    const tree = await treeFixture()
    const { session } = createSession()
    vi.mocked(session.operations.mkdir).mockImplementationOnce((_path, _attributes, callback) =>
      callback(sftpError('already exists', 4))
    )

    await expect(
      transferSshRelayRuntimeTreeViaSftp({
        tree,
        remoteStagingRoot: '/private/existing',
        enforcePosixMode: true,
        signal: new AbortController().signal,
        openSession: async () => session
      })
    ).rejects.toThrow('already exists')
    expect(session.operations.unlink).not.toHaveBeenCalled()
    expect(session.operations.rmdir).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('reverse-cleans only known owned paths after a stream failure', async () => {
    const tree = await treeFixture()
    const { session, events } = createSession()
    vi.mocked(session.operations.write).mockImplementationOnce(
      (_handle, _buffer, _offset, _length, _position, callback) =>
        callback(new Error('remote disk full'))
    )

    await expect(
      transferSshRelayRuntimeTreeViaSftp({
        tree,
        remoteStagingRoot: '/staging/private-content',
        enforcePosixMode: true,
        maximumConcurrency: 1,
        signal: new AbortController().signal,
        openSession: async () => session
      })
    ).rejects.toThrow('remote disk full')

    expect(events.findLast((event) => event.startsWith('rmdir:'))).toBe(
      'rmdir:/staging/private-content'
    )
    expect(events.at(-1)).toBe('close-session')
    expect(JSON.stringify(events)).not.toContain('unknown')
  })

  it('joins cleanup and session-close failures without exposing remote paths', async () => {
    const tree = await treeFixture()
    const { session } = createSession()
    vi.mocked(session.operations.write).mockImplementationOnce(
      (_handle, _buffer, _offset, _length, _position, callback) =>
        callback(new Error('primary transfer failure'))
    )
    vi.mocked(session.operations.rmdir).mockImplementation((_path, callback) =>
      callback(new Error('directory cleanup failure'))
    )
    vi.mocked(session.close).mockRejectedValueOnce(new Error('session close failure'))

    const outcome = transferSshRelayRuntimeTreeViaSftp({
      tree,
      remoteStagingRoot: '/home/secret-user/private-staging',
      enforcePosixMode: true,
      maximumConcurrency: 1,
      signal: new AbortController().signal,
      openSession: async () => session
    })
    await expect(outcome).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ message: 'primary transfer failure' }),
        expect.objectContaining({ message: 'directory cleanup failure' }),
        expect.objectContaining({ message: 'session close failure' })
      ])
    })
    await expect(outcome).rejects.not.toThrow('/home/secret-user/private-staging')
  })

  it('closes the session to settle a retained write callback on cancellation', async () => {
    vi.useFakeTimers()
    try {
      const tree = await treeFixture()
      const { session } = createSession()
      const controller = new AbortController()
      let retainedCallback: Callback | undefined
      let writes = 0
      vi.mocked(session.operations.write).mockImplementationOnce(
        (_handle, _buffer, _offset, _length, _position, callback) => {
          writes += 1
          retainedCallback = callback
        }
      )
      vi.mocked(session.close).mockImplementationOnce(async () => {
        retainedCallback?.(new Error('session closed'))
      })
      const transfer = transferSshRelayRuntimeTreeViaSftp({
        tree,
        remoteStagingRoot: '/staging/content',
        enforcePosixMode: true,
        maximumConcurrency: 1,
        signal: controller.signal,
        openSession: async () => session
      })

      await vi.waitFor(() => expect(writes).toBe(1))
      controller.abort(new Error('cancelled'))
      const rejected = expect(transfer).rejects.toThrow(/cancelled|session closed/)
      await vi.advanceTimersByTimeAsync(250)
      await rejected
      expect(session.close).toHaveBeenCalledOnce()
      expect(writes).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reverse-cleans owned paths before session close when cancellation is not callback-stuck', async () => {
    const tree = await treeFixture()
    const { session, events } = createSession()
    const controller = new AbortController()
    let writes = 0
    const transfer = transferSshRelayRuntimeTreeViaSftp({
      tree,
      remoteStagingRoot: '/staging/cancelled-content',
      enforcePosixMode: true,
      maximumConcurrency: 1,
      signal: controller.signal,
      openSession: async () => session,
      onProgress: ({ bytesTransferred }) => {
        writes += 1
        if (bytesTransferred > 0) {
          controller.abort(new Error('ordinary cancellation'))
        }
      }
    })

    await expect(transfer).rejects.toThrow('ordinary cancellation')
    expect(events.findLastIndex((event) => event.startsWith('rmdir:'))).toBeLessThan(
      events.indexOf('close-session')
    )
    expect(events).toContain('rmdir:/staging/cancelled-content')
    expect(writes).toBe(1)
  })

  it('rejects pre-open cancellation without acquiring a session', async () => {
    const tree = await treeFixture()
    const controller = new AbortController()
    controller.abort(new Error('cancelled before session open'))
    const openSession = vi.fn()

    await expect(
      transferSshRelayRuntimeTreeViaSftp({
        tree,
        remoteStagingRoot: '/staging/content',
        enforcePosixMode: true,
        signal: controller.signal,
        openSession
      })
    ).rejects.toThrow('cancelled before session open')
    expect(openSession).not.toHaveBeenCalled()
  })

  it('rejects a relative staging root before acquiring a session', async () => {
    const tree = await treeFixture()
    const openSession = vi.fn()

    await expect(
      transferSshRelayRuntimeTreeViaSftp({
        tree,
        remoteStagingRoot: 'relative/staging/content',
        enforcePosixMode: true,
        signal: new AbortController().signal,
        openSession
      })
    ).rejects.toThrow(/staging root/i)
    expect(openSession).not.toHaveBeenCalled()
  })
})
