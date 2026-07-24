import { chmod, mkdir, opendir, readFile, rename, stat, unlink, writeFile } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'

type Callback<T = void> = (error: Error | null, value?: T) => void

type DirectoryProbeHandle = {
  close(callback: (error: NodeJS.ErrnoException | null) => void): void
}

export type ManagedHookLocalFilesystemOptions = {
  openDirectory?: (
    path: string,
    callback: (error: NodeJS.ErrnoException | null, directory?: DirectoryProbeHandle) => void
  ) => void
}

function asSftpError(error: NodeJS.ErrnoException): Error & { code: number } {
  const translated = new Error(error.message, { cause: error }) as Error & { code: number }
  translated.code =
    error.code === 'ENOENT' ? 2 : error.code === 'ENOSYS' || error.code === 'ENOTSUP' ? 8 : 4
  return translated
}

function finish<T>(callback: Callback<T>, error: NodeJS.ErrnoException | null, value?: T): void {
  if (error) {
    callback(asSftpError(error))
    return
  }
  callback(null, value)
}

/** The managed installers only need this small callback-style SFTP surface.
 *  On the remote host it turns hundreds of WAN round trips into local fs calls. */
export function createManagedHookLocalFilesystem(
  options?: ManagedHookLocalFilesystemOptions
): SFTPWrapper {
  const openDirectory =
    options?.openDirectory ??
    ((
      path: string,
      callback: (error: NodeJS.ErrnoException | null, directory?: DirectoryProbeHandle) => void
    ) => {
      opendir(path, callback)
    })
  const adapter = {
    readFile(path: string, _encoding: string, callback: Callback<string | Buffer>): void {
      readFile(path, 'utf8', (error, contents) => finish(callback, error, contents))
    },
    orcaReadFileWithinLimit(
      path: string,
      maxBytes: number,
      callback: Callback<string | Buffer>
    ): void {
      void readNodeFileWithinLimit(path, maxBytes).then(
        ({ buffer }) => callback(null, buffer),
        (error: unknown) => {
          if (error instanceof NodeFileReadTooLargeError) {
            callback(error)
            return
          }
          callback(
            error instanceof Error
              ? asSftpError(error as NodeJS.ErrnoException)
              : new Error(String(error))
          )
        }
      )
    },
    writeFile(
      path: string,
      contents: string,
      options: { encoding?: BufferEncoding; mode?: number },
      callback: Callback
    ): void {
      writeFile(path, contents, options, (error) => finish(callback, error))
    },
    stat(path: string, callback: Callback<{ mode: number }>): void {
      stat(path, (error, stats) => finish(callback, error, stats))
    },
    readdir(path: string, callback: Callback<[]>): void {
      // Why: installers only probe directory existence; opening and closing
      // avoids materializing every child name before returning the unused [].
      openDirectory(path, (error, directory) => {
        if (error || !directory) {
          finish(callback, error ?? new Error('Directory probe returned no handle'))
          return
        }
        directory.close((closeError) => finish(callback, closeError, []))
      })
    },
    mkdir(path: string, callback: Callback): void {
      mkdir(path, (error) => finish(callback, error))
    },
    rename(source: string, destination: string, callback: Callback): void {
      rename(source, destination, (error) => finish(callback, error))
    },
    ext_openssh_rename(source: string, destination: string, callback: Callback): void {
      rename(source, destination, (error) => finish(callback, error))
    },
    unlink(path: string, callback: Callback): void {
      unlink(path, (error) => finish(callback, error))
    },
    chmod(path: string, mode: number, callback: Callback): void {
      chmod(path, mode, (error) => finish(callback, error))
    }
  }
  return adapter as unknown as SFTPWrapper
}
