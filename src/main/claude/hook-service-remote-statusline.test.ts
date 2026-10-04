// Why: remote statusline behavior got its own file so hook-service.test.ts
// stays under the max-lines budget — covers the remote opt-out marker contract
// and the context-pressure flag's effect on the managed script body.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, describe, expect, it } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { ClaudeHookService } from './hook-service'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

const STATUSLINE_SCRIPT_FILE_NAME =
  process.platform === 'win32' ? 'claude-statusline.cmd' : 'claude-statusline.sh'

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

describe('ClaudeHookService remote statusline', () => {
  it('rewrites a managed statusline when tracking is disabled after restart', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-statusline-disabled-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const service = new ClaudeHookService()
      service.install()
      service.setContextPressureEnabled(false)

      const script = readFileSync(
        join(tmpHome, '.orca', 'agent-hooks', STATUSLINE_SCRIPT_FILE_NAME),
        'utf-8'
      )
      expect(script).toContain('rate_limits')
      expect(script).not.toContain('context_window')
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('never claims a user-owned remote statusLine slot and writes no orphan script', async () => {
    const svc = new ClaudeHookService()
    const { sftp, fs } = createFakeSftp()
    fs.files.set(
      '/home/dev/.claude/settings.json',
      JSON.stringify({ statusLine: { type: 'command', command: '/usr/local/bin/my-statusline' } })
    )
    const status = await svc.installRemote(sftp, '/home/dev')
    expect(status.state).toBe('installed')
    const parsed = JSON.parse(fs.files.get('/home/dev/.claude/settings.json')!)
    expect(parsed.statusLine.command).toBe('/usr/local/bin/my-statusline')
    expect(fs.files.has('/home/dev/.orca/agent-hooks/claude-statusline.sh')).toBe(false)
    expect(fs.files.has('/home/dev/.orca/agent-hooks/claude-statusline.sh.installed')).toBe(false)
  })

  it('respects a remote statusline opt-out: empty slot plus marker is never re-claimed', async () => {
    const svc = new ClaudeHookService()
    const { sftp, fs } = createFakeSftp()
    const first = await svc.installRemote(sftp, '/home/dev')
    expect(first.state).toBe('installed')
    expect(fs.files.has('/home/dev/.orca/agent-hooks/claude-statusline.sh.installed')).toBe(true)
    // User deletes the managed entry (opt-out); reconnect must not re-claim the slot.
    const parsed = JSON.parse(fs.files.get('/home/dev/.claude/settings.json')!)
    delete parsed.statusLine
    fs.files.set('/home/dev/.claude/settings.json', JSON.stringify(parsed))
    const second = await svc.installRemote(sftp, '/home/dev')
    expect(second.state).toBe('installed')
    const after = JSON.parse(fs.files.get('/home/dev/.claude/settings.json')!)
    expect(after.statusLine).toBeUndefined()
  })

  it('refreshes a managed remote statusline script on reconnect', async () => {
    const svc = new ClaudeHookService()
    const { sftp, fs } = createFakeSftp()
    await svc.installRemote(sftp, '/home/dev')
    fs.files.set('/home/dev/.orca/agent-hooks/claude-statusline.sh', '#!/bin/sh\n# stale body\n')
    await svc.installRemote(sftp, '/home/dev')
    expect(fs.files.get('/home/dev/.orca/agent-hooks/claude-statusline.sh')).toContain(
      '/statusline/claude'
    )
  })
})
