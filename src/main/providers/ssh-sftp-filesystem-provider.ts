/**
 * Filesystem provider for plain SSH mode (design D6 rung D): read, list, stat and write over
 * one reused SFTP channel. Anything that needs the Orca remote server (search, file lists,
 * watching, recursive delete, copy) refuses with that reason instead of hanging on a relay.
 */
import { extname } from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'
import { sortDirEntries } from '../../shared/file-name-sort'
import { IMAGE_FILE_MIME_TYPES } from '../../shared/image-file-extensions'
import { capturePathExistence, type PathExistenceResult } from '../../shared/path-existence-batch'
import type { SearchResult } from '../../shared/code-search-types'
import type { DirEntry } from '../../shared/filesystem-entry-types'
import type { SshPlainSshMode } from '../../shared/ssh-types'
import { PlainSshUnsupportedError } from '../ssh/ssh-plain-ssh-mode'
import {
  downloadFileViaSftp,
  downloadFolderViaSftp,
  type FolderDownloadOptions,
  type SftpFactory
} from './ssh-filesystem-download'
import {
  fileStatFromSftpStats,
  lstatViaSftp,
  readDirViaSftp,
  statViaSftp
} from './ssh-filesystem-provider-sftp'
import type { FileReadLimits, FileReadResult, FileStat, IFilesystemProvider } from './types'

// Why: same caps and probe window as the relay's fs.readFile so previews behave identically.
const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024
const MAX_PREVIEWABLE_BINARY_SIZE = 50 * 1024 * 1024
const BINARY_PROBE_BYTES = 8192
const SFTP_NO_SUCH_FILE = 2
const PREVIEW_MIME_TYPES: Record<string, string> = {
  ...IMAGE_FILE_MIME_TYPES,
  '.pdf': 'application/pdf'
}

/** SFTP resolves relative paths against the login directory, which is `~`. */
export function toSftpPath(path: string): string {
  if (path === '~') {
    return '.'
  }
  return path.startsWith('~/') ? path.slice(2) || '.' : path
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function normalizeSftpError(error: unknown): Error {
  const err = error instanceof Error ? error : new Error(String(error))
  if (errorCode(err) === SFTP_NO_SUCH_FILE) {
    return Object.assign(new Error(`ENOENT: no such file or directory: ${err.message}`), {
      code: 'ENOENT'
    })
  }
  return err
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)
}

export class SshSftpFilesystemProvider implements IFilesystemProvider {
  private sftpPromise: Promise<SFTPWrapper> | null = null
  private disposed = false

  constructor(
    private readonly connectionId: string,
    private readonly createSftp: SftpFactory,
    private readonly mode: SshPlainSshMode,
    private readonly windowsRemotePaths = false
  ) {}

  getConnectionId(): string {
    return this.connectionId
  }

  dispose(): void {
    this.disposed = true
    const pending = this.sftpPromise
    this.sftpPromise = null
    void pending?.then(
      (sftp) => sftp.end(),
      () => {}
    )
  }

  private async sftp(): Promise<SFTPWrapper> {
    if (this.disposed) {
      throw new Error('SSH connection is not active')
    }
    if (!this.sftpPromise) {
      const opening = this.createSftp().then((sftp) => {
        // Why: a closed channel must not be reused; the next call reopens one.
        sftp.once('close', () => {
          if (this.sftpPromise === opening) {
            this.sftpPromise = null
          }
        })
        return sftp
      })
      opening.catch(() => {
        if (this.sftpPromise === opening) {
          this.sftpPromise = null
        }
      })
      this.sftpPromise = opening
    }
    return this.sftpPromise
  }

  /** Round-trips one SFTP request; a silent transport times out as not alive. */
  async probeTransport(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    try {
      return await Promise.race([
        this.realpath('.').then(
          () => true,
          () => false
        ),
        timeout
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private async run<T>(op: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    try {
      return await op(await this.sftp())
    } catch (error) {
      throw normalizeSftpError(error)
    }
  }

  private call<T = void>(
    register: (sftp: SFTPWrapper, cb: (err: Error | null | undefined, value?: T) => void) => void
  ): Promise<T> {
    return this.run(
      (sftp) =>
        new Promise<T>((resolve, reject) => {
          register(sftp, (err, value) =>
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ssh2 passes the operation's value with every successful callback; void operations resolve undefined.
            err ? reject(err) : resolve(value as T)
          )
        })
    )
  }

  private unsupported(feature: string): PlainSshUnsupportedError {
    return new PlainSshUnsupportedError(feature, this.mode)
  }

  async readDir(dirPath: string): Promise<DirEntry[]> {
    const path = toSftpPath(dirPath)
    return this.run(async (sftp) => {
      const entries = await readDirViaSftp(sftp, path)
      const mapped = await Promise.all(
        entries.map(async (entry): Promise<DirEntry> => {
          const isSymlink = entry.attrs.isSymbolicLink()
          let isDirectory = entry.attrs.isDirectory()
          if (isSymlink) {
            // Why: a symlink to a directory must expand in the tree like its target.
            isDirectory = await statViaSftp(sftp, `${path.replace(/\/$/, '')}/${entry.filename}`)
              .then((stats) => stats.isDirectory())
              .catch(() => false)
          }
          return { name: entry.filename, isDirectory, isSymlink }
        })
      )
      return sortDirEntries(mapped)
    })
  }

  async readFile(filePath: string, _limits?: FileReadLimits): Promise<FileReadResult> {
    const path = toSftpPath(filePath)
    return this.run(async (sftp) => {
      const stats = await statViaSftp(sftp, path)
      const mimeType = PREVIEW_MIME_TYPES[extname(filePath).toLowerCase()]
      const sizeLimit = mimeType ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_TEXT_FILE_SIZE
      if (stats.size > sizeLimit) {
        throw new Error(
          `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${sizeLimit / 1024 / 1024}MB limit`
        )
      }
      const buffer = await new Promise<Buffer>((resolve, reject) =>
        sftp.readFile(path, (err, data) => (err ? reject(err) : resolve(data)))
      )
      if (mimeType) {
        return { content: buffer.toString('base64'), isBinary: true, isImage: true, mimeType }
      }
      if (isBinaryBuffer(buffer)) {
        return { content: '', isBinary: true }
      }
      return { content: buffer.toString('utf-8'), isBinary: false }
    })
  }

  async downloadFile(sourcePath: string, destinationPath: string): Promise<void> {
    await downloadFileViaSftp(this.createSftp, toSftpPath(sourcePath), destinationPath)
  }

  // Why: the connect broadcast advertises folder download for every ssh2 target, plain SSH included.
  async downloadFolder(
    sourcePath: string,
    destinationPath: string,
    options?: FolderDownloadOptions
  ): Promise<void> {
    await downloadFolderViaSftp(this.createSftp, toSftpPath(sourcePath), destinationPath, {
      signal: options?.signal,
      windowsRemotePaths: this.windowsRemotePaths
    })
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.call((sftp, cb) => sftp.writeFile(toSftpPath(filePath), content, cb))
  }

  async writeFileBase64(filePath: string, contentBase64: string): Promise<void> {
    const data = Buffer.from(contentBase64, 'base64')
    await this.call((sftp, cb) => sftp.writeFile(toSftpPath(filePath), data, cb))
  }

  async writeFileBase64Chunk(
    filePath: string,
    contentBase64: string,
    append: boolean
  ): Promise<void> {
    const data = Buffer.from(contentBase64, 'base64')
    const path = toSftpPath(filePath)
    await this.call((sftp, cb) =>
      append ? sftp.appendFile(path, data, cb) : sftp.writeFile(path, data, cb)
    )
  }

  async pathsExist(filePaths: string[]): Promise<PathExistenceResult[]> {
    return Promise.all(
      filePaths.map((filePath) =>
        capturePathExistence(() =>
          this.stat(filePath).then(
            () => true,
            (error: unknown) => {
              if (errorCode(error) === 'ENOENT') {
                return false
              }
              throw error
            }
          )
        )
      )
    )
  }

  async stat(filePath: string): Promise<FileStat> {
    return this.run(async (sftp) =>
      fileStatFromSftpStats(await statViaSftp(sftp, toSftpPath(filePath)))
    )
  }

  async lstat(filePath: string): Promise<FileStat> {
    return this.run((sftp) => lstatViaSftp(sftp, toSftpPath(filePath)))
  }

  async deletePath(targetPath: string, recursive?: boolean): Promise<void> {
    const path = toSftpPath(targetPath)
    const stats = await this.run(
      (sftp) =>
        new Promise<Stats>((resolve, reject) =>
          sftp.lstat(path, (err, value) => (err ? reject(err) : resolve(value)))
        )
    )
    if (!stats.isDirectory()) {
      await this.call((sftp, cb) => sftp.unlink(path, cb))
      return
    }
    try {
      await this.call((sftp, cb) => sftp.rmdir(path, cb))
    } catch (error) {
      // Why: a non-empty directory needs a recursive walk the relay does atomically on the host.
      throw recursive ? this.unsupported('Deleting a non-empty folder') : error
    }
  }

  async createFile(filePath: string): Promise<void> {
    const path = toSftpPath(filePath)
    const handle = await this.call<Buffer>((sftp, cb) => sftp.open(path, 'wx', cb))
    await this.call((sftp, cb) => sftp.close(handle, cb))
  }

  async createDir(dirPath: string): Promise<void> {
    await this.call((sftp, cb) => sftp.mkdir(toSftpPath(dirPath), cb))
  }

  async createDirNoClobber(dirPath: string): Promise<void> {
    await this.createDir(dirPath)
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const from = toSftpPath(oldPath)
    const to = toSftpPath(newPath)
    await this.call((sftp, cb) => {
      try {
        // Why: SFTPv3 rename refuses an existing target; the OpenSSH extension overwrites.
        sftp.ext_openssh_rename(from, to, cb)
      } catch {
        sftp.rename(from, to, cb)
      }
    })
  }

  async renameNoClobber(oldPath: string, newPath: string): Promise<void> {
    await this.call((sftp, cb) => sftp.rename(toSftpPath(oldPath), toSftpPath(newPath), cb))
  }

  async copy(): Promise<void> {
    throw this.unsupported('Copying files')
  }

  async realpath(filePath: string): Promise<string> {
    return this.call<string>((sftp, cb) => sftp.realpath(toSftpPath(filePath), cb))
  }

  async search(): Promise<SearchResult> {
    throw this.unsupported('Search')
  }

  async listFiles(): Promise<string[]> {
    throw this.unsupported('Quick Open')
  }

  async supportsQuickOpenSearch(): Promise<boolean> {
    return false
  }

  async supportsFileRangeRead(): Promise<boolean> {
    return false
  }

  async watch(): Promise<() => void> {
    throw this.unsupported('Watching files for changes')
  }
}
