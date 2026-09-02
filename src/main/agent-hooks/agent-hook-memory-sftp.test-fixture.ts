import type { SFTPWrapper } from 'ssh2'

export type AgentHookMemoryFileSystem = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
}

export function createAgentHookMemorySftp(initialFiles: Record<string, string> = {}): {
  sftp: SFTPWrapper
  fs: AgentHookMemoryFileSystem
} {
  const fs: AgentHookMemoryFileSystem = {
    files: new Map(Object.entries(initialFiles)),
    dirs: new Set(['/']),
    modes: new Map()
  }
  const missing = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })
  const sftp = {
    readFile: (path: string, _encoding: string, done: (error: unknown, data?: string) => void) => {
      const data = fs.files.get(path)
      if (data === undefined) {
        done(missing(path))
        return
      }
      done(null, data)
    },
    writeFile: (
      path: string,
      content: string,
      options: string | { mode?: number },
      done: (error: unknown) => void
    ) => {
      fs.files.set(path, content)
      if (typeof options !== 'string' && options.mode !== undefined) {
        fs.modes.set(path, options.mode)
      }
      done(null)
    },
    rename: (source: string, target: string, done: (error: unknown) => void) => {
      const content = fs.files.get(source)
      if (content === undefined) {
        done(missing(source))
        return
      }
      fs.files.set(target, content)
      fs.files.delete(source)
      const mode = fs.modes.get(source)
      if (mode !== undefined) {
        fs.modes.set(target, mode)
        fs.modes.delete(source)
      }
      done(null)
    },
    unlink: (path: string, done: (error: unknown) => void) => {
      fs.files.delete(path)
      fs.modes.delete(path)
      done(null)
    },
    chmod: (path: string, mode: number, done: (error: unknown) => void) => {
      fs.modes.set(path, mode)
      done(null)
    },
    stat: (path: string, done: (error: unknown, stats?: { mode: number }) => void) => {
      if (!fs.files.has(path)) {
        done(missing(path))
        return
      }
      done(null, { mode: fs.modes.get(path) ?? 0o100644 })
    },
    readdir: (path: string, done: (error: unknown, entries?: { filename: string }[]) => void) => {
      if (!fs.dirs.has(path)) {
        done(missing(path))
        return
      }
      done(null, [])
    },
    mkdir: (path: string, done: (error: unknown) => void) => {
      fs.dirs.add(path)
      done(null)
    }
  } as unknown as SFTPWrapper
  return { sftp, fs }
}
