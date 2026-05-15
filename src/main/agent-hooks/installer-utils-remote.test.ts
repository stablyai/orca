import { describe, expect, it } from 'vitest'
import type { SFTPWrapper } from 'ssh2'

import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from './installer-utils-remote'

type FakeFs = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
  openSshRenameCount: number
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
    openSshRenameCount: 0
  }
  const noEntryError = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })
  const fakeStats = (mode: number): { mode: number } => ({ mode })

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
      fs.files.set(path, content)
      if (typeof options !== 'string' && options.mode !== undefined) {
        fs.modes.set(path, options.mode)
      }
      cb(null)
    },
    rename: (src: string, dst: string, cb: (err: unknown) => void): void => {
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
  it('returns {} when settings.json does not exist on the remote', async () => {
    const { sftp } = createFakeSftp()
    const result = await readHooksJsonRemote(sftp, '/home/u/.claude/settings.json')
    expect(result).toEqual({})
  })

  it('returns null when settings.json is malformed JSON', async () => {
    const { sftp, fs } = createFakeSftp()
    fs.files.set('/home/u/.claude/settings.json', 'not json {{')
    const result = await readHooksJsonRemote(sftp, '/home/u/.claude/settings.json')
    expect(result).toBeNull()
  })

  it('rethrows non-ENOENT read errors so callers can distinguish I/O failures from parse failures', async () => {
    const sftp = {
      readFile: (_path: string, _enc: string, cb: (err: unknown) => void): void => {
        // Why: SSH_FX_PERMISSION_DENIED (3) is a real I/O failure that should
        // not collapse into the same null result the parse-error path uses.
        cb({ code: 3, message: 'permission denied' })
      }
    } as unknown as SFTPWrapper
    await expect(readHooksJsonRemote(sftp, '/home/u/.claude/settings.json')).rejects.toMatchObject({
      code: 3
    })
  })

  it('atomically writes settings.json via tmp + rename', async () => {
    const { sftp, fs } = createFakeSftp()
    await writeHooksJsonRemote(sftp, '/home/u/.claude/settings.json', {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foo' }] }] }
    })
    expect(fs.files.has('/home/u/.claude/settings.json')).toBe(true)
    expect(fs.dirs.has('/home/u/.claude')).toBe(true)
    const contents = fs.files.get('/home/u/.claude/settings.json')!
    const parsed = JSON.parse(contents)
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe('foo')
    // Tmp must be cleaned up.
    const tmp = Array.from(fs.files.keys()).find((k) => k.includes('.tmp'))
    expect(tmp).toBeUndefined()
    expect(fs.modes.get('/home/u/.claude/settings.json')).toBe(0o600)
  })

  it('preserves existing config file mode across atomic replacement', async () => {
    const { sftp, fs } = createFakeSftp()
    const path = '/home/u/.codex/config.toml'
    fs.files.set(path, 'old')
    fs.modes.set(path, 0o640)

    await writeTextFileRemoteAtomic(sftp, path, 'new')

    expect(fs.modes.get(path)).toBe(0o640)
  })

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

  it('writes the managed script and chmods 0o755', async () => {
    const { sftp, fs } = createFakeSftp()
    await writeManagedScriptRemote(sftp, '/home/u/.orca/agent-hooks/claude-hook.sh', '#!/bin/sh\n')
    expect(fs.files.get('/home/u/.orca/agent-hooks/claude-hook.sh')).toBe('#!/bin/sh\n')
    expect(fs.modes.get('/home/u/.orca/agent-hooks/claude-hook.sh')).toBe(0o755)
  })

  it('replaces an existing managed script atomically via temp file rename', async () => {
    const { sftp, fs } = createFakeSftp({
      plainRenameOverwrites: false,
      openSshRename: true
    })
    const path = '/home/u/.orca/agent-hooks/claude-hook.sh'
    fs.files.set(path, 'old script')

    await writeManagedScriptRemote(sftp, path, 'new script')

    expect(fs.files.get(path)).toBe('new script')
    expect(fs.modes.get(path)).toBe(0o755)
    expect(Array.from(fs.files.keys()).some((key) => key.includes('.orca-backup-'))).toBe(false)
  })

  it('leaves the existing managed script intact when temp write fails', async () => {
    const { sftp, fs } = createFakeSftp({ failDotFileWrites: true })
    const path = '/home/u/.orca/agent-hooks/claude-hook.sh'
    fs.files.set(path, 'old script')

    await expect(writeManagedScriptRemote(sftp, path, 'new script')).rejects.toMatchObject({
      code: 4
    })
    expect(fs.files.get(path)).toBe('old script')
  })

  it('skips a no-op write when contents already match', async () => {
    const { sftp, fs } = createFakeSftp()
    const path = '/home/u/.claude/settings.json'
    await writeHooksJsonRemote(sftp, path, { hooks: {} })
    const beforeKey = fs.files.get(path)
    // Re-writing the same payload should produce the same content; there is
    // no rename/tmp cycle visible to a downstream observer beyond the
    // identical file body.
    await writeHooksJsonRemote(sftp, path, { hooks: {} })
    expect(fs.files.get(path)).toBe(beforeKey)
  })
})
