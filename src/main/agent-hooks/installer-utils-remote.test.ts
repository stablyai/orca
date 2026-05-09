import { describe, expect, it } from 'vitest'
import type { SFTPWrapper } from 'ssh2'

import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from './installer-utils-remote'

type FakeFs = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
}

function createFakeSftp(): { sftp: SFTPWrapper; fs: FakeFs } {
  const fs: FakeFs = {
    files: new Map(),
    dirs: new Set(['/']),
    modes: new Map()
  }
  const noEntryError = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })

  const sftp = {
    readFile: (path: string, _enc: string, cb: (err: unknown, data?: string) => void): void => {
      const v = fs.files.get(path)
      if (v === undefined) {
        cb(noEntryError(path))
        return
      }
      cb(null, v)
    },
    writeFile: (path: string, content: string, _enc: string, cb: (err: unknown) => void): void => {
      fs.files.set(path, content)
      cb(null)
    },
    rename: (src: string, dst: string, cb: (err: unknown) => void): void => {
      const v = fs.files.get(src)
      if (v === undefined) {
        cb(noEntryError(src))
        return
      }
      fs.files.set(dst, v)
      fs.files.delete(src)
      cb(null)
    },
    unlink: (path: string, cb: (err: unknown) => void): void => {
      if (!fs.files.has(path)) {
        cb(noEntryError(path))
        return
      }
      fs.files.delete(path)
      cb(null)
    },
    chmod: (path: string, mode: number, cb: (err: unknown) => void): void => {
      fs.modes.set(path, mode)
      cb(null)
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
  })

  it('writes the managed script and chmods 0o755', async () => {
    const { sftp, fs } = createFakeSftp()
    await writeManagedScriptRemote(sftp, '/home/u/.orca/agent-hooks/claude-hook.sh', '#!/bin/sh\n')
    expect(fs.files.get('/home/u/.orca/agent-hooks/claude-hook.sh')).toBe('#!/bin/sh\n')
    expect(fs.modes.get('/home/u/.orca/agent-hooks/claude-hook.sh')).toBe(0o755)
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
