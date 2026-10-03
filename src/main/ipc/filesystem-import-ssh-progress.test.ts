import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileUploadSession, IFilesystemProvider } from '../providers/types'
import type { ImportItemResult } from '../../shared/filesystem-import-result-types'
import {
  importSshSourceWithProgress,
  measureLocalUpload,
  registerSshImportCancellations,
  toSshImportProgressTarget
} from './filesystem-import-ssh-progress'
import {
  cancelRuntimeUpload,
  forgetRuntimeUploadCancellation,
  scopeRuntimeUploadId
} from './runtime-upload-cancellation'

type UploadOptions = Parameters<FileUploadSession['uploadFile']>[2]

const SENDER_ID = 7
const SCOPED_ID = scopeRuntimeUploadId(SENDER_ID, 'u1')

function createSender() {
  return { id: SENDER_ID, isDestroyed: vi.fn(() => false), send: vi.fn() }
}

function createProvider(): IFilesystemProvider {
  return {
    readDir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    writeFileBase64: vi.fn(),
    writeFileBase64Chunk: vi.fn(),
    stat: vi.fn(),
    // Why: one node per path, so the rollback's identity check sees what it recorded.
    lstat: vi.fn(async (path: string) => ({
      size: 0,
      type: path.endsWith('/src') ? ('directory' as const) : ('file' as const),
      mtime: 0,
      dev: 1,
      ino: path.length
    })),
    deletePath: vi.fn().mockResolvedValue(undefined),
    createFile: vi.fn(),
    createDir: vi.fn(),
    createDirNoClobber: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn(),
    renameNoClobber: vi.fn(),
    copy: vi.fn(),
    realpath: vi.fn(),
    search: vi.fn(),
    listFiles: vi.fn(),
    watch: vi.fn()
  }
}

function createSession(
  uploadFile: FileUploadSession['uploadFile'] = vi.fn().mockResolvedValue(undefined)
) {
  return {
    uploadFile: vi.fn(uploadFile),
    removeCreatedEntry: vi.fn().mockResolvedValue(undefined),
    close: vi.fn()
  }
}

const imported = (sourcePath: string, destPath: string, kind: 'file' | 'directory') =>
  ({ sourcePath, status: 'imported', destPath, kind, renamed: false }) satisfies ImportItemResult

describe('SSH import progress', () => {
  const roots: string[] = []

  afterEach(async () => {
    forgetRuntimeUploadCancellation(SCOPED_ID)
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function createSource(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-import-progress-'))
    roots.push(root)
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    await writeFile(join(root, 'src', 'a.txt'), 'abcd')
    await writeFile(join(root, 'src', 'nested', 'b.txt'), 'efghij')
    await symlink(join(root, 'src', 'a.txt'), join(root, 'src', 'link.txt'))
    return join(root, 'src')
  }

  async function runImport(
    sourcePath: string,
    session: ReturnType<typeof createSession>,
    run: (
      tracked: FileUploadSession,
      provider: IFilesystemProvider,
      onFailure?: () => void
    ) => Promise<ImportItemResult>,
    options: { sender?: ReturnType<typeof createSender>; assertCurrent?: () => void } = {}
  ) {
    const sender = options.sender ?? createSender()
    const provider = createProvider()
    const target = { sender, uploadIdsBySourcePath: { [sourcePath]: 'u1' } }
    const cancellations = registerSshImportCancellations(target)
    try {
      const result = await importSshSourceWithProgress(
        target,
        cancellations,
        sourcePath,
        provider,
        session,
        options.assertCurrent,
        run
      )
      return { result, provider, sender }
    } finally {
      cancellations.release()
    }
  }

  it('measures the bytes an upload will move, skipping symlinks and unreadable subtrees', async () => {
    const source = await createSource()
    expect(await measureLocalUpload(source)).toEqual({ kind: 'directory', bytes: 10 })

    await chmod(join(source, 'nested'), 0o000)
    try {
      // Why: display-only; one unreadable folder must not zero the whole row.
      expect(await measureLocalUpload(source)).toEqual({ kind: 'directory', bytes: 4 })
    } finally {
      await chmod(join(source, 'nested'), 0o755)
    }
    expect(await measureLocalUpload(join(source, 'missing'))).toEqual({ kind: null, bytes: 0 })
  })

  it('builds a target only when progress ids were sent', () => {
    const sender = createSender()
    expect(toSshImportProgressTarget(null, { '/a': 'u1' })).toBeUndefined()
    expect(toSshImportProgressTarget({ sender }, undefined)).toBeUndefined()
    expect(toSshImportProgressTarget({ sender }, { '/a': 'u1', '/b': '', '/c': 3 })).toEqual({
      sender,
      uploadIdsBySourcePath: { '/a': 'u1' }
    })
  })

  it('runs the plain session when the source has no progress id', async () => {
    const session = createSession()
    const provider = createProvider()
    const run = vi
      .fn()
      .mockResolvedValue({ sourcePath: '/a', status: 'skipped', reason: 'missing' })

    await importSshSourceWithProgress(
      undefined,
      registerSshImportCancellations(undefined),
      '/a',
      provider,
      session,
      undefined,
      run
    )

    expect(run).toHaveBeenCalledWith(session, provider)
  })

  it('holds the bar below 100% until the import settles, then reports the total', async () => {
    const source = await createSource()
    const session = createSession(async (_local, _remote, options: UploadOptions) => {
      options?.onBytesTransferred?.(6)
    })

    const { sender } = await runImport(source, session, async (tracked) => {
      await tracked.uploadFile('/l/a', '/r/a', { exclusive: true })
      await tracked.uploadFile('/l/b', '/r/b', { exclusive: true })
      tracked.close()
      return imported(source, '/r', 'directory')
    })

    const events = sender.send.mock.calls.map(([, progress]) => progress)
    expect(events[0]).toEqual({ uploadId: 'u1', sentBytes: 0, totalBytes: 10, kind: 'directory' })
    expect(events.slice(1, -1).every((event) => event.sentBytes <= 9)).toBe(true)
    expect(events.at(-1)).toEqual({
      uploadId: 'u1',
      sentBytes: 12,
      totalBytes: 10,
      kind: 'directory'
    })
    expect(session.close).not.toHaveBeenCalled()
  })

  it('shows moved bytes mid-transfer when the size is unknown instead of pinning them to zero', async () => {
    const sender = createSender()
    let midTransfer: number[] = []
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const session = createSession(async (_local, _remote, options: UploadOptions) => {
        // Why: step past the throttle window so the slice is eligible to be sent at all.
        vi.setSystemTime(Date.now() + 1000)
        options?.onBytesTransferred?.(5)
        // Why: snapshot before the import settles; the settled report must not mask a stuck bar.
        midTransfer = sender.send.mock.calls.map(([, progress]) => progress.sentBytes)
      })

      await runImport(
        '/does/not/exist',
        session,
        async (tracked) => {
          await tracked.uploadFile('/l/a', '/r/a', { exclusive: true })
          return imported('/does/not/exist', '/r/a', 'file')
        },
        { sender }
      )
    } finally {
      vi.useRealTimers()
    }

    expect(midTransfer).toEqual([0, 5])
  })

  it('undoes exactly what it created when cancelled mid-file', async () => {
    const source = await createSource()
    const session = createSession(
      (_local, _remote, options: UploadOptions) =>
        new Promise<void>((_resolve, reject) => {
          options?.onRemoteCreated?.()
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          cancelRuntimeUpload(SCOPED_ID)
        })
    )

    const { result, provider } = await runImport(
      source,
      session,
      async (tracked, trackedProvider) => {
        await trackedProvider.createDirNoClobber('/r/src')
        try {
          await tracked.uploadFile('/l/a', '/r/src/a', { exclusive: true })
        } catch {
          // Why: importOneSourceSsh's own failure cleanup is recursive; the ledger must intercept it.
          await trackedProvider.deletePath('/r/src', true)
        }
        return { sourcePath: source, status: 'failed', reason: 'aborted' }
      }
    )

    expect(result).toEqual({
      sourcePath: source,
      status: 'failed',
      reason: 'Upload cancelled',
      cancelled: true
    })
    expect(session.removeCreatedEntry.mock.calls).toEqual([
      ['/r/src/a', 'file'],
      ['/r/src', 'directory']
    ])
    expect(provider.deletePath).not.toHaveBeenCalled()
  })

  it('records nothing for an exclusive create it lost, so a cancel removes nothing', async () => {
    const source = await createSource()
    const session = createSession(async (_local, _remote, options: UploadOptions) => {
      cancelRuntimeUpload(SCOPED_ID)
      options?.signal?.throwIfAborted()
    })

    const { result } = await runImport(source, session, async (tracked) => {
      await tracked.uploadFile('/l/a', '/r/a', { exclusive: true }).catch(() => {})
      return { sourcePath: source, status: 'failed', reason: 'EEXIST' }
    })

    expect(result.status).toBe('failed')
    expect(session.removeCreatedEntry).not.toHaveBeenCalled()
  })

  it('rolls back a source whose cancel arrives after its last byte', async () => {
    const source = await createSource()
    const session = createSession(async (_local, _remote, options: UploadOptions) => {
      options?.onRemoteCreated?.()
    })

    const { result } = await runImport(source, session, async (tracked) => {
      await tracked.uploadFile('/l/a', '/r/a', { exclusive: true })
      cancelRuntimeUpload(SCOPED_ID)
      return imported(source, '/r/a', 'file')
    })

    expect(result).toEqual({
      sourcePath: source,
      status: 'failed',
      reason: 'Upload cancelled',
      cancelled: true
    })
    expect(session.removeCreatedEntry).toHaveBeenCalledWith('/r/a', 'file')
  })

  it('reports what a rollback could not remove instead of hiding it', async () => {
    const source = await createSource()
    const session = createSession(async (_local, _remote, options: UploadOptions) => {
      options?.onRemoteCreated?.()
    })
    session.removeCreatedEntry.mockImplementation(async (_path: string, kind: string) => {
      if (kind === 'directory') {
        throw new Error('ENOTEMPTY')
      }
    })

    const { result } = await runImport(source, session, async (tracked, provider) => {
      await provider.createDirNoClobber('/r/src')
      await tracked.uploadFile('/l/a', '/r/src/a', { exclusive: true })
      cancelRuntimeUpload(SCOPED_ID)
      return imported(source, '/r/src', 'directory')
    })

    expect(result).toEqual({
      sourcePath: source,
      status: 'failed',
      reason: 'Upload cancelled; partial upload left at /r/src',
      cancelled: true
    })
  })

  it('never cleans up for a session that was replaced before the cancel', async () => {
    const source = await createSource()
    const session = createSession(async (_local, _remote, options: UploadOptions) => {
      options?.onRemoteCreated?.()
    })
    let current = true

    const { result } = await runImport(
      source,
      session,
      async (tracked) => {
        await tracked.uploadFile('/l/a', '/r/a', { exclusive: true })
        current = false
        cancelRuntimeUpload(SCOPED_ID)
        return imported(source, '/r/a', 'file')
      },
      {
        assertCurrent: () => {
          if (!current) {
            throw new Error('session replaced')
          }
        }
      }
    )

    expect(session.removeCreatedEntry).not.toHaveBeenCalled()
    expect(result).toMatchObject({ reason: 'Upload cancelled; partial upload left at /r/a' })
  })

  it('starts no remote write when cancelled while the source is still being measured', async () => {
    const source = await createSource()
    cancelRuntimeUpload(SCOPED_ID)
    const session = createSession()
    const run = vi.fn()

    const { result } = await runImport(source, session, run)

    expect(result).toEqual({
      sourcePath: source,
      status: 'failed',
      reason: 'Upload cancelled',
      cancelled: true
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('ignores a cancel sent for the same id from another window', async () => {
    const source = await createSource()
    const session = createSession()

    const { result } = await runImport(source, session, async () => {
      cancelRuntimeUpload(scopeRuntimeUploadId(SENDER_ID + 1, 'u1'))
      return imported(source, '/r/a', 'file')
    })

    expect(result.status).toBe('imported')
    expect(session.removeCreatedEntry).not.toHaveBeenCalled()
    forgetRuntimeUploadCancellation(scopeRuntimeUploadId(SENDER_ID + 1, 'u1'))
  })

  it('reports leftovers after a failure that was not a cancel', async () => {
    const source = await createSource()
    const session = createSession(async (_local, _remote, options: UploadOptions) => {
      options?.onRemoteCreated?.()
      throw new Error('Remote connection dropped')
    })
    session.removeCreatedEntry.mockRejectedValue(new Error('channel closed'))

    const { result } = await runImport(source, session, async (tracked, provider) => {
      await provider.createDirNoClobber('/r/src')
      try {
        await tracked.uploadFile('/l/a', '/r/src/a', { exclusive: true })
      } catch {
        await provider.deletePath('/r/src', true)
      }
      return { sourcePath: source, status: 'failed', reason: 'Remote connection dropped' }
    })

    expect(result).toEqual({
      sourcePath: source,
      status: 'failed',
      reason: 'Remote connection dropped; 2 partial items left under /r/src'
    })
  })

  // Why: runs mirror importOneSourceSsh, whose catch reports the failure before any cleanup.
  it('keeps a real failure when cancel is clicked while it is being cleaned up', async () => {
    const source = await createSource()
    const session = createSession(async (_local, _remote, options: UploadOptions) => {
      options?.onRemoteCreated?.()
      throw new Error('No space left on device')
    })

    const { result } = await runImport(source, session, async (tracked, provider, onFailure) => {
      await provider.createDirNoClobber('/r/src')
      try {
        await tracked.uploadFile('/l/a', '/r/src/a', { exclusive: true })
      } catch {
        onFailure?.()
        // The user cancels while the failed folder is being removed.
        cancelRuntimeUpload(SCOPED_ID)
        await provider.deletePath('/r/src', true)
      }
      return { sourcePath: source, status: 'failed', reason: 'No space left on device' }
    })

    expect(result).toEqual({
      sourcePath: source,
      status: 'failed',
      reason: 'No space left on device'
    })
    expect(session.removeCreatedEntry).toHaveBeenCalledWith('/r/src', 'directory')
  })

  it('still reports a cancel when the failure came from the cancel itself', async () => {
    const source = await createSource()
    const session = createSession(async (_local, _remote, options: UploadOptions) => {
      options?.onRemoteCreated?.()
      cancelRuntimeUpload(SCOPED_ID)
      throw new Error('This operation was aborted')
    })

    const { result } = await runImport(source, session, async (tracked, _provider, onFailure) => {
      try {
        await tracked.uploadFile('/l/a', '/r/a', { exclusive: true })
      } catch {
        onFailure?.()
      }
      return { sourcePath: source, status: 'failed', reason: 'This operation was aborted' }
    })

    expect(result).toEqual({
      sourcePath: source,
      status: 'failed',
      reason: 'Upload cancelled',
      cancelled: true
    })
  })
})
