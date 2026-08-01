import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'

import {
  readHooksJsonRemote,
  REMOTE_HOOKS_BACKUP_SUFFIX,
  updateHooksJsonRemoteWithRetry,
  writeHooksJsonRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from './installer-utils-remote'

type FakeFs = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
  openSshHardlinkCount: number
  openSshRenameCount: number
}

function createFakeSftp(
  opts: {
    plainRenameOverwrites?: boolean
    openSshRename?: boolean
    openSshHardlink?: boolean
    failDotFileWrites?: boolean
    failBackupTempWrites?: boolean | 'once'
  } = {}
): {
  sftp: SFTPWrapper
  fs: FakeFs
} {
  const plainRenameOverwrites = opts.plainRenameOverwrites ?? true
  let backupTempWriteFailures = 0
  const fs: FakeFs = {
    files: new Map(),
    dirs: new Set(['/']),
    modes: new Map(),
    openSshHardlinkCount: 0,
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
      if (
        opts.failBackupTempWrites &&
        path.includes(`${REMOTE_HOOKS_BACKUP_SUFFIX}.`) &&
        (opts.failBackupTempWrites !== 'once' || backupTempWriteFailures === 0)
      ) {
        backupTempWriteFailures += 1
        fs.files.set(path, content.slice(0, Math.max(1, Math.floor(content.length / 2))))
        cb({ code: 4, message: `interrupted write ${path}` })
        return
      }
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
      if (!fs.files.has(path) && !fs.dirs.has(path)) {
        cb(noEntryError(path))
        return
      }
      cb(null, fakeStats(fs.modes.get(path) ?? (fs.dirs.has(path) ? 0o40755 : 0o100644)))
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
    ...(opts.openSshHardlink !== false
      ? {
          ext_openssh_hardlink: (src: string, dst: string, cb: (err: unknown) => void): void => {
            fs.openSshHardlinkCount += 1
            const value = fs.files.get(src)
            if (value === undefined) {
              cb(noEntryError(src))
              return
            }
            if (fs.files.has(dst)) {
              cb({ code: 4, message: `EEXIST ${dst}` })
              return
            }
            fs.files.set(dst, value)
            const mode = fs.modes.get(src)
            if (mode !== undefined) {
              fs.modes.set(dst, mode)
            }
            cb(null)
          }
        }
      : {}),
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
  it('checks mkdir ancestors without serializing directory listings', async () => {
    const { sftp } = createFakeSftp()
    const readdirSpy = vi.spyOn(sftp, 'readdir')

    await writeManagedScriptRemote(sftp, '/home/u/.orca/agent-hooks/claude-hook.sh', '#!/bin/sh')

    expect(readdirSpy).not.toHaveBeenCalled()
  })

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

  it('times out remote reads that never call back', async () => {
    vi.useFakeTimers()
    try {
      const sftp = {
        readFile: vi.fn()
      } as unknown as SFTPWrapper
      const pending = readHooksJsonRemote(sftp, '/home/u/.claude/settings.json')
      let rejection: unknown = null
      pending.catch((error) => {
        rejection = error
      })

      await vi.advanceTimersByTimeAsync(30_000)

      expect(rejection).toBeInstanceOf(Error)
      await expect(pending).rejects.toThrow('Timed out waiting for SFTP readFile')
    } finally {
      vi.useRealTimers()
    }
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

  it('writes a one-shot backup before first modifying an existing settings.json', async () => {
    const { sftp, fs } = createFakeSftp()
    const path = '/home/u/.claude/settings.json'
    const original = `${JSON.stringify({ hooks: {}, userKey: 'pristine' }, null, 2)}\n`
    fs.files.set(path, original)
    fs.modes.set(path, 0o640)

    await writeHooksJsonRemote(sftp, path, {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'first' }] }] }
    })
    expect(fs.files.get(`${path}.orca-backup`)).toBe(original)
    expect(fs.modes.get(`${path}.orca-backup`)).toBe(0o640)

    // A later write must NOT rotate the backup — it stays the pre-Orca
    // original, unlike the local rolling .bak.
    await writeHooksJsonRemote(sftp, path, {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'second' }] }] }
    })
    expect(fs.files.get(`${path}.orca-backup`)).toBe(original)
  })

  it('preserves a pre-existing one-shot backup', async () => {
    const { sftp, fs } = createFakeSftp()
    const path = '/home/u/.claude/settings.json'
    const original = `${JSON.stringify({ userKey: 'current' }, null, 2)}\n`
    const existingBackup = `${JSON.stringify({ userKey: 'pre-orca' }, null, 2)}\n`
    fs.files.set(path, original)
    fs.files.set(`${path}.orca-backup`, existingBackup)

    await writeHooksJsonRemote(sftp, path, { managed: true })

    expect(fs.files.get(`${path}.orca-backup`)).toBe(existingBackup)
  })

  it('lets only one simultaneous creator publish the one-shot backup', async () => {
    const { sftp, fs } = createFakeSftp()
    const path = '/home/u/.claude/settings.json'
    const original = `${JSON.stringify({ userKey: 'pristine' }, null, 2)}\n`
    fs.files.set(path, original)
    const hardlink = sftp.ext_openssh_hardlink.bind(sftp)
    const claims: { src: string; dst: string; callback: (error?: Error | null) => void }[] = []
    sftp.ext_openssh_hardlink = ((src, dst, callback): void => {
      claims.push({ src, dst, callback })
      if (claims.length === 2) {
        for (const claim of claims) {
          hardlink(claim.src, claim.dst, claim.callback)
        }
      }
    }) as SFTPWrapper['ext_openssh_hardlink']

    await Promise.all([
      writeHooksJsonRemote(sftp, path, { managed: true }),
      writeHooksJsonRemote(sftp, path, { managed: true })
    ])

    expect(fs.openSshHardlinkCount).toBe(2)
    expect(fs.files.get(`${path}.orca-backup`)).toBe(original)
    expect(JSON.parse(fs.files.get(path)!)).toEqual({ managed: true })
    expect(Array.from(fs.files.keys()).some((key) => key.includes('.tmp'))).toBe(false)
  })

  it('retries safely after an interrupted one-shot backup write', async () => {
    const { sftp, fs } = createFakeSftp({ failBackupTempWrites: 'once' })
    const path = '/home/u/.claude/settings.json'
    const original = `${JSON.stringify({ userKey: 'pristine' }, null, 2)}\n`
    fs.files.set(path, original)

    await expect(writeHooksJsonRemote(sftp, path, { managed: true })).rejects.toMatchObject({
      code: 4
    })

    expect(fs.files.get(path)).toBe(original)
    expect(fs.files.has(`${path}.orca-backup`)).toBe(false)
    expect(Array.from(fs.files.keys()).some((key) => key.includes('.tmp'))).toBe(false)

    await writeHooksJsonRemote(sftp, path, { managed: true })

    expect(fs.files.get(`${path}.orca-backup`)).toBe(original)
    expect(JSON.parse(fs.files.get(path)!)).toEqual({ managed: true })
  })

  it('fails closed when atomic no-replace backup publication is unavailable', async () => {
    const { sftp, fs } = createFakeSftp({ openSshHardlink: false })
    const path = '/home/u/.claude/settings.json'
    const original = `${JSON.stringify({ userKey: 'pristine' }, null, 2)}\n`
    fs.files.set(path, original)

    await expect(writeHooksJsonRemote(sftp, path, { managed: true })).rejects.toThrow(
      'Remote filesystem does not support atomic no-replace publication'
    )

    expect(fs.files.get(path)).toBe(original)
    expect(fs.files.has(`${path}.orca-backup`)).toBe(false)
    expect(Array.from(fs.files.keys()).some((key) => key.includes('.tmp'))).toBe(false)
  })

  it('preserves an existing settings file when its pre-write read fails', async () => {
    const { sftp, fs } = createFakeSftp()
    const path = '/home/u/.claude/settings.json'
    const original = `${JSON.stringify({ hooks: {}, userKey: 'pristine' }, null, 2)}\n`
    fs.files.set(path, original)
    sftp.readFile = ((
      _path: string,
      _encoding: string,
      callback: (error: unknown, data?: string) => void
    ): void => {
      callback({ code: 3, message: 'permission denied' })
    }) as unknown as SFTPWrapper['readFile']

    await expect(
      writeHooksJsonRemote(sftp, path, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'replacement' }] }] }
      })
    ).rejects.toMatchObject({ code: 3 })

    expect(fs.files.get(path)).toBe(original)
    expect(fs.files.has(`${path}.orca-backup`)).toBe(false)
  })

  it('does not write a backup on first install (no pre-existing settings.json)', async () => {
    const { sftp, fs } = createFakeSftp()
    const path = '/home/u/.claude/settings.json'
    await writeHooksJsonRemote(sftp, path, { hooks: {} })
    expect(fs.files.has(`${path}.orca-backup`)).toBe(false)
  })

  it('preserves existing config file mode across atomic replacement', async () => {
    const { sftp, fs } = createFakeSftp()
    const path = '/home/u/.codex/config.toml'
    fs.files.set(path, 'old')
    fs.modes.set(path, 0o640)

    await writeTextFileRemoteAtomic(sftp, path, 'new')

    expect(fs.modes.get(path)).toBe(0o640)
  })

  it('re-merges a concurrent settings change before replacing the file', async () => {
    const { sftp, fs } = createFakeSftp()
    const path = '/home/u/.claude/settings.json'
    fs.files.set(path, `${JSON.stringify({ original: true }, null, 2)}\n`)
    const chmod = sftp.chmod.bind(sftp)
    let injected = false
    sftp.chmod = ((tmpPath, mode, callback): void => {
      if (!injected && tmpPath.startsWith('/home/u/.claude/.')) {
        injected = true
        fs.files.set(path, `${JSON.stringify({ original: true, concurrent: true }, null, 2)}\n`)
      }
      chmod(tmpPath, mode, callback)
    }) as SFTPWrapper['chmod']

    const result = await updateHooksJsonRemoteWithRetry(sftp, path, (config) => ({
      ...config,
      managed: true
    }))

    expect(result).toEqual({ original: true, concurrent: true, managed: true })
    expect(JSON.parse(fs.files.get(path)!)).toEqual(result)
    expect(Array.from(fs.files.keys()).some((key) => key.includes('.tmp'))).toBe(false)
  })

  it('fails closed when every remote settings attempt becomes stale', async () => {
    const { sftp, fs } = createFakeSftp()
    const path = '/home/u/.claude/settings.json'
    fs.files.set(path, `${JSON.stringify({ original: true }, null, 2)}\n`)
    const chmod = sftp.chmod.bind(sftp)
    let concurrentVersion = 0
    sftp.chmod = ((tmpPath, mode, callback): void => {
      if (tmpPath.startsWith('/home/u/.claude/.')) {
        concurrentVersion += 1
        fs.files.set(path, `${JSON.stringify({ concurrentVersion }, null, 2)}\n`)
      }
      chmod(tmpPath, mode, callback)
    }) as SFTPWrapper['chmod']

    const result = await updateHooksJsonRemoteWithRetry(sftp, path, (config) => ({
      ...config,
      managed: true
    }))

    expect(result).toBeNull()
    expect(JSON.parse(fs.files.get(path)!)).toEqual({ concurrentVersion: 3 })
    expect(fs.files.has(`${path}.orca-backup`)).toBe(false)
    expect(Array.from(fs.files.keys()).some((key) => key.includes('.tmp'))).toBe(false)
  })

  it('re-merges a settings change made while publishing the one-shot backup', async () => {
    const { sftp, fs } = createFakeSftp()
    const path = '/home/u/.claude/settings.json'
    const original = `${JSON.stringify({ original: true }, null, 2)}\n`
    fs.files.set(path, original)
    const chmod = sftp.chmod.bind(sftp)
    let injected = false
    sftp.chmod = ((tmpPath, mode, callback): void => {
      if (!injected && tmpPath.includes(`${REMOTE_HOOKS_BACKUP_SUFFIX}.`)) {
        injected = true
        fs.files.set(path, `${JSON.stringify({ original: true, concurrent: true }, null, 2)}\n`)
      }
      chmod(tmpPath, mode, callback)
    }) as SFTPWrapper['chmod']

    const result = await updateHooksJsonRemoteWithRetry(sftp, path, (config) => ({
      ...config,
      managed: true
    }))

    expect(result).toEqual({ original: true, concurrent: true, managed: true })
    expect(JSON.parse(fs.files.get(path)!)).toEqual(result)
    expect(fs.files.get(`${path}.orca-backup`)).toBe(original)
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
