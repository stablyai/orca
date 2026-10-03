import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileUploadSession, IFilesystemProvider } from '../providers/types'

const { getConnMgrMock } = vi.hoisted(() => ({ getConnMgrMock: vi.fn() }))
vi.mock('./ssh', () => ({ getSshConnectionManager: getConnMgrMock }))

import { importExternalPathsSsh } from './filesystem-import-ssh'
import {
  cancelRuntimeUpload,
  forgetRuntimeUploadCancellation,
  scopeRuntimeUploadId
} from './runtime-upload-cancellation'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'

type UploadOptions = Parameters<FileUploadSession['uploadFile']>[2]
type RemoteEntry = {
  kind: 'file' | 'directory' | 'fifo' | 'symlink'
  content: string
  owner: string
}

// Why: a new entry object is a new node, so replacing a path changes its inode like a real FS.
const inodes = new WeakMap<RemoteEntry, number>()
let nextInode = 1
function inodeOf(entry: RemoteEntry): number {
  let inode = inodes.get(entry)
  if (inode === undefined) {
    inode = nextInode++
    inodes.set(entry, inode)
  }
  return inode
}

const SENDER = { id: 5, isDestroyed: () => false, send: vi.fn() }
const errno = (code: string): Error => Object.assign(new Error(code), { code })

/**
 * An in-memory remote with the semantics the real transports have: an exclusive
 * create of an existing regular file or directory fails with EEXIST, but — like
 * `set -C` — an existing FIFO is opened without error and without the created
 * marker. A recursive delete throws, so any `rm -rf` in a tracked import fails loudly.
 */
class FakeRemote {
  entries = new Map<string, RemoteEntry>([
    ['/remote', { kind: 'directory', content: '', owner: 'setup' }]
  ])
  // Why: lets a test act (cancel, disconnect) at an exact point inside a transfer.
  beforeChunk: (remotePath: string, chunkIndex: number) => Promise<void> | void = () => {}
  beforeOpen: (remotePath: string) => void = () => {}
  beforeRemove: (remotePath: string) => void = () => {}
  afterUpload: (remotePath: string) => void = () => {}
  // Why: lets a test fail the identity read taken right after a create.
  failNextLstat = new Set<string>()

  has(path: string): boolean {
    return this.entries.has(path)
  }

  provider(owner: string): IFilesystemProvider {
    const uploadSession: FileUploadSession = {
      uploadFile: (local, remote, options) => this.upload(owner, local, remote, options),
      removeCreatedEntry: async (path, kind) => {
        this.beforeRemove(path)
        const entry = this.entries.get(path)
        // Why: like SFTP, unlink removes any non-directory node (a symlink too); rmdir only dirs.
        if (!entry || (kind === 'directory') !== (entry.kind === 'directory')) {
          throw errno('ENOENT')
        }
        if (
          kind === 'directory' &&
          [...this.entries.keys()].some((k) => k.startsWith(`${path}/`))
        ) {
          throw errno('ENOTEMPTY')
        }
        this.entries.delete(path)
      },
      close: () => {}
    }
    return {
      readDir: vi.fn(),
      readFile: vi.fn(),
      downloadFile: vi.fn(),
      openFileUploadSession: vi.fn(async () => uploadSession),
      writeFile: vi.fn(),
      writeFileBase64: vi.fn(),
      writeFileBase64Chunk: vi.fn(),
      lstat: vi.fn(async (path: string) => {
        if (this.failNextLstat.delete(path)) {
          throw new Error('relay busy')
        }
        const entry = this.entries.get(path)
        if (!entry) {
          throw errno('ENOENT')
        }
        // Why: like the relay's fileStatFromLstat, a FIFO reports as 'file'; only dev/ino tell it apart.
        const type =
          entry.kind === 'directory' || entry.kind === 'symlink' ? entry.kind : ('file' as const)
        return { size: entry.content.length, type, mtime: 0, dev: 1, ino: inodeOf(entry) }
      }),
      stat: vi.fn(async (path: string) => {
        const linked = this.entries.get(path)
        // Why: like the relay's fs.stat, follow a symlink to its target.
        const entry = linked?.kind === 'symlink' ? this.entries.get(linked.content) : linked
        if (!entry) {
          throw errno('ENOENT')
        }
        return {
          size: entry.content.length,
          type: entry.kind === 'directory' ? ('directory' as const) : ('file' as const),
          mtime: 0
        }
      }),
      deletePath: vi.fn(async (path: string, recursive?: boolean) => {
        if (recursive) {
          throw new Error(`recursive delete of ${path} in a tracked import`)
        }
        this.entries.delete(path)
      }),
      createFile: vi.fn(),
      createDir: vi.fn(),
      createDirNoClobber: vi.fn(async (path: string) => {
        if (this.entries.has(path)) {
          throw errno('EEXIST')
        }
        this.entries.set(path, { kind: 'directory', content: '', owner })
      }),
      rename: vi.fn(),
      renameNoClobber: vi.fn(),
      copy: vi.fn(),
      realpath: vi.fn(),
      search: vi.fn(),
      listFiles: vi.fn(),
      watch: vi.fn()
    }
  }

  private async upload(
    owner: string,
    localPath: string,
    remotePath: string,
    options: UploadOptions
  ): Promise<void> {
    this.beforeOpen(remotePath)
    const existing = this.entries.get(remotePath)
    if (existing?.kind === 'fifo') {
      // Why: the pre-open existence check refuses it before any open that could block.
      throw errno('EEXIST')
    }
    if (options?.exclusive && existing) {
      throw errno('EEXIST')
    }
    const body = await readFile(localPath, 'utf8')
    const entry: RemoteEntry = { kind: 'file', content: '', owner }
    this.entries.set(remotePath, entry)
    options?.onRemoteCreated?.()
    for (let index = 0; index * 4 < Math.max(body.length, 1); index++) {
      await this.beforeChunk(remotePath, index)
      options?.signal?.throwIfAborted()
      const chunk = body.slice(index * 4, index * 4 + 4)
      entry.content += chunk
      options?.onBytesTransferred?.(chunk.length)
    }
    this.afterUpload(remotePath)
  }
}

function fileCount(remote: FakeRemote): number {
  let count = 0
  for (const entry of remote.entries.values()) {
    count += entry.kind === 'file' ? 1 : 0
  }
  return count
}

describe('SSH import cancel invariants', () => {
  const roots: string[] = []
  const ids: string[] = []
  let remote: FakeRemote

  beforeEach(() => {
    remote = new FakeRemote()
    getConnMgrMock.mockReturnValue({
      getConnection: () => ({ getState: () => ({ status: 'connected' }) })
    })
  })

  afterEach(async () => {
    unregisterSshFilesystemProvider('ssh-a')
    unregisterSshFilesystemProvider('ssh-b')
    for (const id of ids.splice(0)) {
      forgetRuntimeUploadCancellation(scopeRuntimeUploadId(SENDER.id, id))
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function localTree(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-ssh-cancel-'))
    roots.push(root)
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(join(root, relative, '..'), { recursive: true })
      await writeFile(join(root, relative), content)
    }
    return root
  }

  function importWithProgress(connectionId: string, sourcePath: string, uploadId: string) {
    ids.push(uploadId)
    return importExternalPathsSsh([sourcePath], '/remote', connectionId, {
      progress: { sender: SENDER, uploadIdsBySourcePath: { [sourcePath]: uploadId } }
    })
  }

  const cancel = (uploadId: string): void =>
    cancelRuntimeUpload(scopeRuntimeUploadId(SENDER.id, uploadId))

  it('removes only its own files from a folder cancelled between create and first byte', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`batch/f${index}.txt`, `payload-${index}`])
    )
    const source = join(await localTree(files), 'batch')
    registerSshFilesystemProvider('ssh-a', remote.provider('a'))
    remote.beforeChunk = (_path, chunkIndex) => {
      // Why: file 150 exists remotely but holds zero bytes — the narrowest cancel window.
      if (fileCount(remote) === 150 && chunkIndex === 0) {
        // Why: another client writes into the new folder before the cancel lands; it is not ours.
        remote.entries.set('/remote/batch/agent-output.txt', {
          kind: 'file',
          content: 'agent',
          owner: 'agent'
        })
        cancel('u-batch')
      }
    }

    const { results } = await importWithProgress('ssh-a', source, 'u-batch')

    expect(results[0]).toMatchObject({
      status: 'failed',
      reason: 'Upload cancelled; partial upload left at /remote/batch'
    })
    expect([...remote.entries.keys()].sort()).toEqual([
      '/remote',
      '/remote/batch',
      '/remote/batch/agent-output.txt'
    ])
  })

  it('never deletes a file a concurrent upload won with an exclusive create', async () => {
    const a = await localTree({ 'report.txt': 'from-a-complete' })
    const b = await localTree({ 'report.txt': 'from-b' })
    registerSshFilesystemProvider('ssh-a', remote.provider('a'))
    registerSshFilesystemProvider('ssh-b', remote.provider('b'))
    let releaseA: () => void = () => {}
    const aPaused = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    remote.beforeChunk = async (path, chunkIndex) => {
      // Why: hold A after its create so B deconflicts against a name A already owns.
      if (
        path === '/remote/report.txt' &&
        chunkIndex === 1 &&
        remote.entries.get(path)?.owner === 'a'
      ) {
        await aPaused
      }
    }

    const importA = importWithProgress('ssh-a', join(a, 'report.txt'), 'u-a')
    await vi.waitFor(() => expect(remote.has('/remote/report.txt')).toBe(true))
    // B sees the name taken, deconflicts to "report copy.txt", and is cancelled mid-transfer.
    remote.beforeChunk = async (path, chunkIndex) => {
      if (path === '/remote/report copy.txt' && chunkIndex === 1) {
        cancel('u-b')
      }
      if (path === '/remote/report.txt' && chunkIndex === 1) {
        await aPaused
      }
    }
    const resultB = await importWithProgress('ssh-b', join(b, 'report.txt'), 'u-b')
    releaseA()
    const resultA = await importA

    expect(resultB.results[0]).toMatchObject({ status: 'failed' })
    expect(resultA.results[0]).toMatchObject({ status: 'imported', destPath: '/remote/report.txt' })
    expect(remote.entries.get('/remote/report.txt')).toMatchObject({
      owner: 'a',
      content: 'from-a-complete'
    })
    expect(remote.has('/remote/report copy.txt')).toBe(false)
  })

  it('does not delete a file whose exclusive create lost the race when cancel lands', async () => {
    const source = await localTree({ 'notes.txt': 'mine' })
    const provider = remote.provider('a')
    registerSshFilesystemProvider('ssh-a', provider)
    // Why: another client creates the name after deconfliction but before our exclusive open.
    vi.mocked(provider.stat).mockRejectedValue(errno('ENOENT'))
    remote.entries.set('/remote/notes.txt', { kind: 'file', content: 'theirs', owner: 'other' })
    // Why: cancelling before the import would stop it before the transport ever opens.
    remote.beforeOpen = () => cancel('u-lost')

    const { results } = await importWithProgress('ssh-a', join(source, 'notes.txt'), 'u-lost')

    expect(results[0]).toMatchObject({ status: 'failed' })
    expect(remote.entries.get('/remote/notes.txt')).toMatchObject({
      owner: 'other',
      content: 'theirs'
    })
  })

  it('keeps an existing same-name file intact when the upload beside it is cancelled', async () => {
    const source = await localTree({ 'data.csv': 'new-content-that-is-long' })
    remote.entries.set('/remote/data.csv', { kind: 'file', content: 'original', owner: 'user' })
    registerSshFilesystemProvider('ssh-a', remote.provider('a'))
    remote.beforeChunk = (path, chunkIndex) => {
      if (chunkIndex === 2) {
        cancel('u-same')
      }
      expect(path).not.toBe('/remote/data.csv')
    }

    const { results } = await importWithProgress('ssh-a', join(source, 'data.csv'), 'u-same')

    expect(results[0]).toMatchObject({ status: 'failed' })
    expect(remote.entries.get('/remote/data.csv')).toMatchObject({ content: 'original' })
    expect(remote.has('/remote/data copy.csv')).toBe(false)
  })

  it('treats a dropped connection as a failure, not a cancel, and deletes nothing', async () => {
    const source = await localTree({ 'big.bin': 'aaaabbbbcccc' })
    registerSshFilesystemProvider('ssh-a', remote.provider('a'))
    remote.beforeChunk = (_path, chunkIndex) => {
      if (chunkIndex === 1) {
        throw new Error('Remote connection dropped')
      }
    }

    const { results } = await importWithProgress('ssh-a', join(source, 'big.bin'), 'u-drop')

    expect(results[0]).toMatchObject({
      status: 'failed',
      reason: 'Remote connection dropped; partial upload left at /remote/big.bin'
    })
    expect(results[0]).not.toHaveProperty('cancelled')
    // Why: loss of contact is not the user's cancel; the partial stays for the user to judge.
    expect(remote.entries.get('/remote/big.bin')).toMatchObject({ content: 'aaaa' })
  })

  it('opens nothing on the remote when cancel lands before the upload starts', async () => {
    const source = await localTree({ 'early.txt': 'data' })
    registerSshFilesystemProvider('ssh-a', remote.provider('a'))
    remote.beforeOpen = vi.fn()
    cancel('u-early')

    const { results } = await importWithProgress('ssh-a', join(source, 'early.txt'), 'u-early')

    expect(results[0]).toMatchObject({ status: 'failed' })
    expect(remote.beforeOpen).not.toHaveBeenCalled()
    expect(remote.has('/remote/early.txt')).toBe(false)
  })

  it('reports a real folder failure even when cancel is clicked during its cleanup', async () => {
    const source = join(await localTree({ 'out/a.txt': 'aaaa', 'out/b.txt': 'bbbb' }), 'out')
    registerSshFilesystemProvider('ssh-a', remote.provider('a'))
    remote.beforeChunk = (path) => {
      if (path.endsWith('b.txt')) {
        throw new Error('No space left on device')
      }
    }
    // The user cancels once the failed folder starts being removed.
    remote.beforeRemove = () => cancel('u-full')

    const { results } = await importWithProgress('ssh-a', source, 'u-full')

    expect(results[0]).toMatchObject({ status: 'failed', reason: 'No space left on device' })
    expect(results[0]).not.toHaveProperty('cancelled')
    expect(remote.has('/remote/out')).toBe(false)
  })

  it('never deletes an existing FIFO at the destination when cancel lands', async () => {
    const source = await localTree({ 'pipe.txt': 'data' })
    const provider = remote.provider('a')
    registerSshFilesystemProvider('ssh-a', provider)
    // Why: the FIFO appears after deconfliction checked the name.
    vi.mocked(provider.stat).mockRejectedValue(errno('ENOENT'))
    remote.entries.set('/remote/pipe.txt', { kind: 'fifo', content: '', owner: 'other' })
    remote.beforeOpen = () => cancel('u-fifo')

    const { results } = await importWithProgress('ssh-a', join(source, 'pipe.txt'), 'u-fifo')

    expect(results[0]).toMatchObject({ status: 'failed' })
    expect(remote.entries.get('/remote/pipe.txt')).toMatchObject({ kind: 'fifo', owner: 'other' })
  })

  it('does not clean up later when cancel is clicked after the connection dropped', async () => {
    const source = await localTree({ 'big.bin': 'aaaabbbbcccc' })
    const provider = remote.provider('a')
    registerSshFilesystemProvider('ssh-a', provider)
    remote.beforeChunk = (_path, chunkIndex) => {
      if (chunkIndex === 1) {
        throw new Error('Remote connection dropped')
      }
    }

    await importWithProgress('ssh-a', join(source, 'big.bin'), 'u-late')
    // Why: the import has returned; a cancel now must not reach whatever owns the path next.
    cancel('u-late')
    await Promise.resolve()

    expect(remote.entries.get('/remote/big.bin')).toMatchObject({ content: 'aaaa' })
    expect(provider.deletePath).not.toHaveBeenCalled()
  })

  it('keeps a file another client rewrote after our upload finished, and reports it', async () => {
    const source = await localTree({ 'report.md': 'ours' })
    registerSshFilesystemProvider('ssh-a', remote.provider('a'))
    remote.afterUpload = (path) => {
      // Why: an editor or agent saves over the fresh file before the late cancel is processed.
      remote.entries.set(path, { kind: 'file', content: 'their longer edit', owner: 'editor' })
      cancel('u-edit')
    }

    const { results } = await importWithProgress('ssh-a', join(source, 'report.md'), 'u-edit')

    expect(results[0]).toMatchObject({
      status: 'failed',
      reason: 'Upload cancelled; partial upload left at /remote/report.md'
    })
    expect(remote.entries.get('/remote/report.md')).toMatchObject({ content: 'their longer edit' })
  })

  it('keeps a symlink another client put where our finished file was', async () => {
    const source = await localTree({ 'notes.txt': 'our notes' })
    registerSshFilesystemProvider('ssh-a', remote.provider('a'))
    remote.entries.set('/remote/small.txt', { kind: 'file', content: 'x', owner: 'other' })
    remote.afterUpload = (path) => {
      // Why: points at a smaller file, so a size check that follows links would call it ours.
      remote.entries.set(path, { kind: 'symlink', content: '/remote/small.txt', owner: 'other' })
      cancel('u-link')
    }

    const { results } = await importWithProgress('ssh-a', join(source, 'notes.txt'), 'u-link')

    expect(results[0]).toMatchObject({
      status: 'failed',
      reason: 'Upload cancelled; partial upload left at /remote/notes.txt'
    })
    expect(remote.entries.get('/remote/notes.txt')).toMatchObject({ kind: 'symlink' })
  })

  it('keeps a same-size file an atomic-rename save put in place of ours', async () => {
    const source = await localTree({ 'config.json': '{"a":1}' })
    registerSshFilesystemProvider('ssh-a', remote.provider('a'))
    remote.afterUpload = (path) => {
      // Why: same size, so only the changed inode shows it is no longer ours.
      remote.entries.set(path, { kind: 'file', content: '{"b":2}', owner: 'editor' })
      cancel('u-rename')
    }

    const { results } = await importWithProgress('ssh-a', join(source, 'config.json'), 'u-rename')

    expect(results[0]).toMatchObject({ status: 'failed' })
    expect(remote.entries.get('/remote/config.json')).toMatchObject({ content: '{"b":2}' })
  })

  it('keeps a file another client appended to after a mid-file cancel', async () => {
    const source = await localTree({ 'log.txt': 'aaaabbbbccccdddd' })
    registerSshFilesystemProvider('ssh-a', remote.provider('a'))
    remote.beforeChunk = (path, chunkIndex) => {
      if (chunkIndex === 1) {
        // Why: still under the source size, so only the sent-bytes bound catches the append.
        const entry = remote.entries.get(path)
        if (entry) {
          entry.content += 'xxxxxx'
        }
        cancel('u-append')
      }
    }

    const { results } = await importWithProgress('ssh-a', join(source, 'log.txt'), 'u-append')

    expect(results[0]).toMatchObject({ status: 'failed' })
    expect(remote.entries.get('/remote/log.txt')?.content).toBe('aaaaxxxxxx')
  })

  it('keeps a file whose identity could not be read at creation, rather than trusting its size', async () => {
    const source = await localTree({ 'config.json': '{"a":1}' })
    registerSshFilesystemProvider('ssh-a', remote.provider('a'))
    remote.failNextLstat.add('/remote/config.json')
    remote.afterUpload = (path) => {
      // Why: same size, so with no identity only "cannot verify" keeps the editor's save.
      remote.entries.set(path, { kind: 'file', content: '{"b":2}', owner: 'editor' })
      cancel('u-noid')
    }

    const { results } = await importWithProgress('ssh-a', join(source, 'config.json'), 'u-noid')

    expect(results[0]).toMatchObject({
      status: 'failed',
      reason: 'Upload cancelled; partial upload left at /remote/config.json'
    })
    expect(remote.entries.get('/remote/config.json')).toMatchObject({ content: '{"b":2}' })
  })
})
