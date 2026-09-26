import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

import { bobHookService } from '../bob/hook-service'

type FakeFs = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
  failRenameTo: Set<string>
}

function createFakeSftp(initialFiles: Record<string, string> = {}): {
  sftp: SFTPWrapper
  fs: FakeFs
} {
  const fs: FakeFs = {
    files: new Map(Object.entries(initialFiles)),
    dirs: new Set(['/']),
    modes: new Map(),
    failRenameTo: new Set()
  }
  const noEntryError = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })
  const fakeStats = (mode: number): { mode: number } => ({ mode })

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Bob installer calls only the SFTP methods stubbed here, and each test asserts the files they write.
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
    }
  } as unknown as SFTPWrapper
  return { sftp, fs }
}

describe('remote Bob hook installer', () => {
  it('installs remote Bob hooks into ~/.bob/settings/settings.json, preserving user settings', async () => {
    const { sftp, fs } = createFakeSftp({
      '/home/dev/.bob/settings/settings.json': JSON.stringify({
        theme: 'dark',
        hooks: {
          PreToolUse: [
            { matcher: 'execute_command', hooks: [{ type: 'command', command: 'echo mine' }] }
          ]
        }
      })
    })

    const status = await bobHookService.installRemote(sftp, '/home/dev')

    expect(status).toMatchObject({ agent: 'bob', state: 'installed' })
    // Why: SSH remotes always get the POSIX script, even when Orca runs on Windows.
    const script = fs.files.get('/home/dev/.orca/agent-hooks/bob-hook.sh')
    expect(script).toMatch(/^#!\/bin\/sh\n/)
    expect(script).toContain('/hook/bob')

    const written = JSON.parse(fs.files.get('/home/dev/.bob/settings/settings.json')!)
    expect(written.theme).toBe('dark')
    expect(written.hooks.PreToolUse).toHaveLength(2)
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('echo mine')
    // Why: Bob validates each entry with a strict schema and drops every global hook on an
    // unknown key, so the remote write must carry exactly type/command/timeout and no matcher.
    const managed = written.hooks.Stop[0]
    expect(Object.keys(managed)).toEqual(['hooks'])
    expect(Object.keys(managed.hooks[0]).sort()).toEqual(['command', 'timeout', 'type'])
    expect(managed.hooks[0].command).toContain('/home/dev/.orca/agent-hooks/bob-hook.sh')
  })

  it('does not overwrite a malformed remote Bob settings.json', async () => {
    const { sftp, fs } = createFakeSftp({ '/home/dev/.bob/settings/settings.json': '{ not json' })

    const status = await bobHookService.installRemote(sftp, '/home/dev')

    expect(status).toMatchObject({ agent: 'bob', state: 'error' })
    expect(fs.files.get('/home/dev/.bob/settings/settings.json')).toBe('{ not json')
  })
})
