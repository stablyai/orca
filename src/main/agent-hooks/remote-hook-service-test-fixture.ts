import type { SFTPWrapper } from 'ssh2'
import { posix } from 'node:path'

export type FakeRemoteHookFs = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
  failRenameTo: Set<string>
}

export function createFakeSftp(initialFiles: Record<string, string> = {}): {
  sftp: SFTPWrapper
  fs: FakeRemoteHookFs
} {
  const dirs = new Set(['/'])
  for (const path of Object.keys(initialFiles)) {
    let parent = posix.dirname(path)
    while (!dirs.has(parent)) {
      dirs.add(parent)
      const next = posix.dirname(parent)
      if (next === parent) {
        break
      }
      parent = next
    }
  }
  const fs: FakeRemoteHookFs = {
    files: new Map(Object.entries(initialFiles)),
    dirs,
    modes: new Map(),
    failRenameTo: new Set()
  }
  const noEntryError = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })
  const fakeStats = (mode: number): { mode: number } => ({ mode })
  const requireParent = (path: string, cb: (err: unknown) => void): boolean => {
    const parent = posix.dirname(path)
    if (fs.dirs.has(parent)) {
      return true
    }
    cb(noEntryError(parent))
    return false
  }

  const sftp = {
    readFile: (path: string, _enc: string, cb: (err: unknown, data?: string) => void): void => {
      const value = fs.files.get(path)
      if (value === undefined) {
        cb(noEntryError(path))
        return
      }
      cb(null, value)
    },
    writeFile: (
      path: string,
      content: string,
      options: string | { mode?: number },
      cb: (err: unknown) => void
    ): void => {
      if (!requireParent(path, cb)) {
        return
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
      if (!requireParent(dst, cb)) {
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
      fs.files.delete(path)
      fs.modes.delete(path)
      cb(null)
    },
    chmod: (path: string, mode: number, cb: (err: unknown) => void): void => {
      fs.modes.set(path, mode)
      cb(null)
    },
    stat: (path: string, cb: (err: unknown, stats?: { mode: number }) => void): void => {
      if (fs.dirs.has(path)) {
        cb(null, fakeStats(0o040755))
        return
      }
      if (!fs.files.has(path)) {
        cb(noEntryError(path))
        return
      }
      cb(null, fakeStats(fs.modes.get(path) ?? 0o100644))
    },
    readdir: (path: string, cb: (err: unknown, list?: { filename: string }[]) => void): void => {
      if (fs.dirs.has(path)) {
        const prefix = path === '/' ? '/' : `${path}/`
        const children = new Set<string>()
        for (const candidate of [...fs.dirs, ...fs.files.keys()]) {
          if (!candidate.startsWith(prefix) || candidate === path) {
            continue
          }
          const remainder = candidate.slice(prefix.length)
          if (remainder && !remainder.includes('/')) {
            children.add(remainder)
          }
        }
        cb(
          null,
          [...children].sort().map((filename) => ({ filename }))
        )
        return
      }
      cb(noEntryError(path))
    },
    mkdir: (path: string, cb: (err: unknown) => void): void => {
      if (!requireParent(path, cb)) {
        return
      }
      fs.dirs.add(path)
      cb(null)
    }
  } as unknown as SFTPWrapper
  return { sftp, fs }
}
