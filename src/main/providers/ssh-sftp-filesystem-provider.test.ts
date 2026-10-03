import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { SshSftpFilesystemProvider, toSftpPath } from './ssh-sftp-filesystem-provider'
import { downloadFolderViaSftp } from './ssh-filesystem-download'
import type * as SshFilesystemDownload from './ssh-filesystem-download'

vi.mock('./ssh-filesystem-download', async (importOriginal) => ({
  ...(await importOriginal<typeof SshFilesystemDownload>()),
  downloadFolderViaSftp: vi.fn(async () => {})
}))

type Node = { kind: 'file'; content: Buffer } | { kind: 'dir' } | { kind: 'link'; target: string }
type Callback = (err: Error | null, value?: unknown) => void

function stats(node: Node, size = 0) {
  return {
    size,
    mtime: 1_700_000_000,
    isDirectory: () => node.kind === 'dir',
    isSymbolicLink: () => node.kind === 'link',
    isFile: () => node.kind === 'file'
  }
}

function noSuchFile(): Error {
  return Object.assign(new Error('No such file'), { code: 2 })
}

/** In-memory SFTP server double covering the calls the provider makes. */
class FakeSftp extends EventEmitter {
  readonly nodes = new Map<string, Node>()
  readonly end = vi.fn()
  posixRename = true

  private resolve(path: string): Node | undefined {
    const node = this.nodes.get(path)
    return node?.kind === 'link' ? this.nodes.get(node.target) : node
  }

  private sizeOf(node: Node): number {
    return node.kind === 'file' ? node.content.length : 0
  }

  readdir(path: string, cb: Callback): void {
    const prefix = `${path}/`
    const entries = [...this.nodes]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, node]) => ({ filename: p.slice(prefix.length), attrs: stats(node) }))
    cb(null, entries)
  }

  stat(path: string, cb: Callback): void {
    const node = this.resolve(path)
    return node ? cb(null, stats(node, this.sizeOf(node))) : cb(noSuchFile())
  }

  lstat(path: string, cb: Callback): void {
    const node = this.nodes.get(path)
    return node ? cb(null, stats(node, this.sizeOf(node))) : cb(noSuchFile())
  }

  readFile(path: string, cb: Callback): void {
    const node = this.resolve(path)
    return node?.kind === 'file' ? cb(null, node.content) : cb(noSuchFile())
  }

  writeFile(path: string, data: string | Buffer, cb: Callback): void {
    this.nodes.set(path, { kind: 'file', content: Buffer.from(data) })
    cb(null)
  }

  appendFile(path: string, data: Buffer, cb: Callback): void {
    const node = this.nodes.get(path)
    const prior = node?.kind === 'file' ? node.content : Buffer.alloc(0)
    this.nodes.set(path, { kind: 'file', content: Buffer.concat([prior, data]) })
    cb(null)
  }

  unlink(path: string, cb: Callback): void {
    this.nodes.delete(path)
    cb(null)
  }

  rmdir(path: string, cb: Callback): void {
    const hasChildren = [...this.nodes.keys()].some((p) => p.startsWith(`${path}/`))
    if (hasChildren) {
      cb(Object.assign(new Error('Failure'), { code: 4 }))
      return
    }
    this.nodes.delete(path)
    cb(null)
  }

  mkdir(path: string, cb: Callback): void {
    this.nodes.set(path, { kind: 'dir' })
    cb(null)
  }

  rename(from: string, to: string, cb: Callback): void {
    if (this.nodes.has(to)) {
      cb(Object.assign(new Error('Failure'), { code: 4 }))
      return
    }
    this.nodes.set(to, this.nodes.get(from)!)
    this.nodes.delete(from)
    cb(null)
  }

  ext_openssh_rename(from: string, to: string, cb: Callback): void {
    if (!this.posixRename) {
      throw new Error('Server does not support this extended request')
    }
    this.nodes.set(to, this.nodes.get(from)!)
    this.nodes.delete(from)
    cb(null)
  }

  realpath(path: string, cb: Callback): void {
    cb(null, path === '.' ? '/home/me' : path)
  }
}

const MODE = { reason: 'home_noexec', message: 'noexec home' }

function createProvider() {
  const sftp = new FakeSftp()
  const createSftp = vi.fn(async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeSftp implements every SFTPWrapper method the provider calls.
    return sftp as unknown as SFTPWrapper
  })
  const provider = new SshSftpFilesystemProvider('target-1', createSftp, MODE)
  return { provider, sftp, createSftp }
}

describe('SshSftpFilesystemProvider', () => {
  it('maps home-relative paths onto the SFTP login directory', () => {
    expect(toSftpPath('~')).toBe('.')
    expect(toSftpPath('~/src/app')).toBe('src/app')
    expect(toSftpPath('/etc/hosts')).toBe('/etc/hosts')
  })

  it('lists a directory sorted, resolving symlinked directories like their target', async () => {
    const { provider, sftp, createSftp } = createProvider()
    sftp.nodes.set('/w/b.txt', { kind: 'file', content: Buffer.from('b') })
    sftp.nodes.set('/w/src', { kind: 'dir' })
    sftp.nodes.set('/w/link', { kind: 'link', target: '/w/src' })
    sftp.nodes.set('/w/dangling', { kind: 'link', target: '/nowhere' })

    await expect(provider.readDir('/w')).resolves.toEqual([
      { name: 'link', isDirectory: true, isSymlink: true },
      { name: 'src', isDirectory: true, isSymlink: false },
      { name: 'b.txt', isDirectory: false, isSymlink: false },
      { name: 'dangling', isDirectory: false, isSymlink: true }
    ])
    await provider.stat('/w/b.txt')
    // One SFTP channel is reused across operations.
    expect(createSftp).toHaveBeenCalledTimes(1)
  })

  it('reads text, flags binary, and returns images as base64', async () => {
    const { provider, sftp } = createProvider()
    sftp.nodes.set('/a.txt', { kind: 'file', content: Buffer.from('héllo') })
    sftp.nodes.set('/a.bin', { kind: 'file', content: Buffer.from([1, 0, 2]) })
    sftp.nodes.set('/a.png', { kind: 'file', content: Buffer.from([137, 80]) })

    await expect(provider.readFile('/a.txt')).resolves.toEqual({
      content: 'héllo',
      isBinary: false
    })
    await expect(provider.readFile('/a.bin')).resolves.toEqual({ content: '', isBinary: true })
    await expect(provider.readFile('/a.png')).resolves.toMatchObject({
      content: Buffer.from([137, 80]).toString('base64'),
      isImage: true,
      mimeType: 'image/png'
    })
  })

  it('reports missing paths as ENOENT so existence checks stay truthful', async () => {
    const { provider, sftp } = createProvider()
    sftp.nodes.set('/here', { kind: 'file', content: Buffer.from('') })
    await expect(provider.stat('/gone')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(provider.pathsExist(['/here', '/gone'])).resolves.toEqual([
      { exists: true },
      { exists: false }
    ])
  })

  it('writes, appends, creates and renames files', async () => {
    const { provider, sftp } = createProvider()
    await provider.writeFile('/f', 'one')
    await provider.writeFileBase64Chunk('/f', Buffer.from('two').toString('base64'), true)
    expect(sftp.nodes.get('/f')).toEqual({ kind: 'file', content: Buffer.from('onetwo') })

    await provider.createDir('/d')
    await provider.rename('/f', '/d/f')
    expect(sftp.nodes.has('/d/f')).toBe(true)

    sftp.posixRename = false
    await provider.writeFile('/g', 'g')
    await provider.rename('/g', '/h')
    expect(sftp.nodes.has('/h')).toBe(true)
    await expect(provider.renameNoClobber('/h', '/d/f')).rejects.toThrow('Failure')
  })

  it('deletes files and empty folders but refuses a recursive delete with the reason', async () => {
    const { provider, sftp } = createProvider()
    sftp.nodes.set('/d', { kind: 'dir' })
    sftp.nodes.set('/d/x', { kind: 'file', content: Buffer.from('x') })
    await expect(provider.deletePath('/d', true)).rejects.toThrow(
      'Deleting a non-empty folder needs the Orca remote server'
    )
    await provider.deletePath('/d/x')
    await provider.deletePath('/d')
    expect(sftp.nodes.size).toBe(0)
  })

  it('refuses relay-only features with the classified reason', async () => {
    const { provider } = createProvider()
    await expect(provider.watch()).rejects.toThrow('(home_noexec)')
    await expect(provider.search()).rejects.toThrow('Search needs the Orca remote server')
    await expect(provider.listFiles()).rejects.toThrow('Quick Open')
    await expect(provider.copy()).rejects.toThrow('Copying files')
    await expect(provider.supportsQuickOpenSearch()).resolves.toBe(false)
  })

  it('downloads folders over SFTP with the host path style', async () => {
    const { createSftp } = createProvider()
    const windowsProvider = new SshSftpFilesystemProvider('target-1', createSftp, MODE, true)
    const signal = new AbortController().signal
    await windowsProvider.downloadFolder('~/proj', '/tmp/dest', { signal })
    expect(downloadFolderViaSftp).toHaveBeenCalledWith(createSftp, 'proj', '/tmp/dest', {
      signal,
      windowsRemotePaths: true
    })
  })

  it('probes the transport with one SFTP round trip and times out a silent one', async () => {
    const { provider, sftp } = createProvider()
    await expect(provider.probeTransport(1_000)).resolves.toBe(true)
    sftp.realpath = () => {}
    vi.useFakeTimers()
    try {
      const probe = provider.probeTransport(5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(probe).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reopens SFTP after the channel closes and ends it on dispose', async () => {
    const { provider, sftp, createSftp } = createProvider()
    sftp.nodes.set('/x', { kind: 'file', content: Buffer.from('') })
    await provider.stat('/x')
    sftp.emit('close')
    await provider.stat('/x')
    expect(createSftp).toHaveBeenCalledTimes(2)

    provider.dispose()
    await Promise.resolve()
    expect(sftp.end).toHaveBeenCalled()
    await expect(provider.stat('/x')).rejects.toThrow('not active')
  })
})
