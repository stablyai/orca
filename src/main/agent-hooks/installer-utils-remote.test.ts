import { describe, expect, it } from 'vitest'
import type { SFTPWrapper } from 'ssh2'

import { writeHooksJsonRemote, writeManagedScriptRemote } from './installer-utils-remote'

type FakeFs = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
  openSshRenameCount: number
  operations: { kind: string; path: string; destination?: string }[]
}

function createFakeSftp(
  opts: {
    plainRenameOverwrites?: boolean
    openSshRename?: boolean
    failDotFileWrites?: boolean
  } = {}
): {
  sftp: SFTPWrapper
  fs: FakeFs
} {
  const plainRenameOverwrites = opts.plainRenameOverwrites ?? true
  const fs: FakeFs = {
    files: new Map(),
    dirs: new Set(['/']),
    modes: new Map(),
    openSshRenameCount: 0,
    operations: []
  }
  const noEntryError = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })
  const fakeStats = (mode: number): { mode: number } => ({ mode })

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fake implements every SFTP operation exercised below.
  const sftp = {
    readFile: (path: string, _enc: string, cb: (err: unknown, data?: string) => void): void => {
      const v = fs.files.get(path)
      if (v === undefined) {
        cb(noEntryError(path))
        return
      }
      cb(null, v)
    },
    writeFile: (
      path: string,
      content: string,
      options: string | { mode?: number },
      cb: (err: unknown) => void
    ): void => {
      if (opts.failDotFileWrites && path.includes('/.')) {
        cb({ code: 4, message: `write failed ${path}` })
        return
      }
      fs.operations.push({ kind: 'write', path })
      fs.files.set(path, content)
      if (typeof options !== 'string' && options.mode !== undefined) {
        fs.modes.set(path, options.mode)
      }
      cb(null)
    },
    rename: (src: string, dst: string, cb: (err: unknown) => void): void => {
      fs.operations.push({ kind: 'rename', path: src, destination: dst })
      const v = fs.files.get(src)
      if (v === undefined) {
        cb(noEntryError(src))
        return
      }
      if (!plainRenameOverwrites && fs.files.has(dst)) {
        cb({ code: 4, message: `SSH_FX_FAILURE destination exists ${dst}` })
        return
      }
      fs.files.set(dst, v)
      fs.files.delete(src)
      const mode = fs.modes.get(src)
      if (mode !== undefined) {
        fs.modes.set(dst, mode)
        fs.modes.delete(src)
      }
      cb(null)
    },
    unlink: (path: string, cb: (err: unknown) => void): void => {
      if (!fs.files.has(path)) {
        cb(noEntryError(path))
        return
      }
      fs.files.delete(path)
      fs.modes.delete(path)
      cb(null)
    },
    chmod: (path: string, mode: number, cb: (err: unknown) => void): void => {
      fs.operations.push({ kind: 'chmod', path })
      fs.modes.set(path, mode)
      cb(null)
    },
    stat: (path: string, cb: (err: unknown, stats?: { mode: number }) => void): void => {
      if (!fs.files.has(path)) {
        cb(noEntryError(path))
        return
      }
      cb(null, fakeStats(fs.modes.get(path) ?? 0o100644))
    },
    readdir: (path: string, cb: (err: unknown, list?: { filename: string }[]) => void): void => {
      if (fs.dirs.has(path)) {
        cb(null, [])
        return
      }
      cb(noEntryError(path))
    },
    mkdir: (path: string, cb: (err: unknown) => void): void => {
      fs.dirs.add(path)
      cb(null)
    },
    ...(opts.openSshRename
      ? {
          ext_openssh_rename: (src: string, dst: string, cb: (err: unknown) => void): void => {
            fs.openSshRenameCount += 1
            fs.operations.push({ kind: 'openssh-rename', path: src, destination: dst })
            const v = fs.files.get(src)
            if (v === undefined) {
              cb(noEntryError(src))
              return
            }
            fs.files.set(dst, v)
            fs.files.delete(src)
            const mode = fs.modes.get(src)
            if (mode !== undefined) {
              fs.modes.set(dst, mode)
              fs.modes.delete(src)
            }
            cb(null)
          }
        }
      : {})
  } as unknown as SFTPWrapper
  return { sftp, fs }
}

describe('installer-utils-remote', () => {
  it('uses OpenSSH overwrite rename when an atomic write updates an existing file', async () => {
    const { sftp, fs } = createFakeSftp({
      plainRenameOverwrites: false,
      openSshRename: true
    })
    const path = '/home/u/.claude/settings.json'
    fs.files.set(path, JSON.stringify({ hooks: {} }))

    await writeHooksJsonRemote(sftp, path, {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'new' }] }] }
    })

    expect(fs.openSshRenameCount).toBe(1)
    expect(JSON.parse(fs.files.get(path)!).hooks.Stop[0].hooks[0].command).toBe('new')
  })

  it('leaves existing files intact when overwrite rename is unavailable', async () => {
    const { sftp, fs } = createFakeSftp({ plainRenameOverwrites: false })
    const path = '/home/u/.claude/settings.json'
    fs.files.set(path, JSON.stringify({ hooks: { Stop: [] } }))

    await expect(
      writeHooksJsonRemote(sftp, path, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'fallback' }] }] }
      })
    ).rejects.toMatchObject({ code: 4 })

    expect(JSON.parse(fs.files.get(path)!).hooks.Stop).toEqual([])
    expect(Array.from(fs.files.keys()).some((key) => key.includes('.tmp'))).toBe(false)
  })

  it('leaves the existing managed script intact when temp write fails', async () => {
    const { sftp, fs } = createFakeSftp({ failDotFileWrites: true })
    const path = '/home/u/.orca/agent-hooks/claude-hook.sh'
    fs.files.set(path, 'old script')

    await expect(writeManagedScriptRemote(sftp, path, 'new script')).rejects.toMatchObject({
      code: 4
    })
    expect(fs.files.get(path)).toBe('old script')
    expect([...fs.files.keys()]).toEqual([path])
  })
})
