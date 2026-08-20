import type { SFTPWrapper } from 'ssh2'

export type RemoteHookTestFilesystem = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
  failRenameTo: Set<string>
  beforeExclusiveWrite?: (path: string) => void
  beforeUnlink?: (path: string) => void
}

export function createRemoteHookTestFilesystem(initialFiles: Record<string, string> = {}): {
  sftp: SFTPWrapper
  fs: RemoteHookTestFilesystem
} {
  const fs: RemoteHookTestFilesystem = {
    files: new Map(Object.entries(initialFiles)),
    dirs: new Set(['/']),
    modes: new Map(),
    failRenameTo: new Set()
  }
  const noEntryError = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })

  const sftp = {
    readFile: (path: string, _enc: string, cb: (err: unknown, data?: string) => void): void => {
      const value = fs.files.get(path)
      if (value === undefined) {
        cb(noEntryError(path))
      } else {
        cb(null, value)
      }
    },
    writeFile: (
      path: string,
      content: string,
      options: string | { mode?: number; flag?: string },
      cb: (err: unknown) => void
    ): void => {
      if (typeof options !== 'string' && options.flag === 'wx') {
        fs.beforeExclusiveWrite?.(path)
        if (fs.files.has(path)) {
          cb({ code: 4, message: `file exists ${path}` })
          return
        }
      }
      fs.files.set(path, content)
      if (typeof options !== 'string' && options.mode !== undefined) {
        fs.modes.set(path, options.mode)
      }
      cb(null)
    },
    rename: (src: string, dst: string, cb: (err: unknown) => void): void => {
      if (fs.failRenameTo.has(dst)) {
        cb({ code: 4, message: `rename failed ${dst}` })
        return
      }
      const value = fs.files.get(src)
      if (value === undefined) {
        cb(noEntryError(src))
        return
      }
      fs.files.set(dst, value)
      fs.files.delete(src)
      const mode = fs.modes.get(src)
      if (mode !== undefined) {
        fs.modes.set(dst, mode)
        fs.modes.delete(src)
      }
      cb(null)
    },
    unlink: (path: string, cb: (err: unknown) => void): void => {
      fs.beforeUnlink?.(path)
      fs.files.delete(path)
      fs.modes.delete(path)
      cb(null)
    },
    chmod: (path: string, mode: number, cb: (err: unknown) => void): void => {
      fs.modes.set(path, mode)
      cb(null)
    },
    stat: (path: string, cb: (err: unknown, stats?: { mode: number }) => void): void => {
      if (!fs.files.has(path)) {
        cb(noEntryError(path))
        return
      }
      cb(null, { mode: fs.modes.get(path) ?? 0o100644 })
    },
    readdir: (path: string, cb: (err: unknown, list?: { filename: string }[]) => void): void => {
      if (fs.dirs.has(path)) {
        cb(null, [])
      } else {
        cb(noEntryError(path))
      }
    },
    mkdir: (path: string, cb: (err: unknown) => void): void => {
      fs.dirs.add(path)
      cb(null)
    }
  } as unknown as SFTPWrapper
  return { sftp, fs }
}
