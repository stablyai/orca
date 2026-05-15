// Why: locks in the remote-install contract so a refactor cannot silently
// drift the produced settings.json shape, the wrapper-quoted command path,
// or the script body that lands on the remote box. Local install behavior
// is exercised through `installer-utils.test.ts` and the per-CLI status
// audit; this file covers ONLY the SFTP-backed path added in commit #8.
import { vi, describe, expect, it } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

import type { SFTPWrapper } from 'ssh2'
import { ClaudeHookService } from './hook-service'

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

describe('ClaudeHookService.installRemote', () => {
  it('writes settings.json + managed script under the remote $HOME', async () => {
    const svc = new ClaudeHookService()
    const { sftp, fs } = createFakeSftp()
    const status = await svc.installRemote(sftp, '/home/dev')
    expect(status.state).toBe('installed')
    expect(status.configPath).toBe('/home/dev/.claude/settings.json')
    const settings = fs.files.get('/home/dev/.claude/settings.json')
    expect(settings).toBeTruthy()
    const parsed = JSON.parse(settings!)
    // Why: every load-bearing event must be present and point at the
    // remote-shaped script path with the `if [ -x ... ]; then ... fi`
    // wrapper applied. Drift in any of these is a real bug — Claude
    // Code rejects unknown shapes silently and the agent-hooks pipeline
    // goes dark.
    for (const event of [
      'UserPromptSubmit',
      'Stop',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest'
    ]) {
      expect(parsed.hooks[event]).toBeTruthy()
      const cmd = parsed.hooks[event][0].hooks[0].command as string
      expect(cmd).toContain('/home/dev/.orca/agent-hooks/claude-hook.sh')
      expect(cmd).toMatch(/^if \[ -x /)
    }
    // Managed script body
    expect(fs.files.get('/home/dev/.orca/agent-hooks/claude-hook.sh')).toContain('#!/bin/sh')
    expect(fs.modes.get('/home/dev/.orca/agent-hooks/claude-hook.sh')).toBe(0o755)
  })

  it('reports parse error when remote settings.json is malformed', async () => {
    const svc = new ClaudeHookService()
    const { sftp, fs } = createFakeSftp()
    fs.files.set('/home/dev/.claude/settings.json', 'not json')
    const status = await svc.installRemote(sftp, '/home/dev')
    expect(status.state).toBe('error')
    expect(status.detail).toContain('Could not parse')
  })

  it('preserves user-authored hook entries on a fresh install', async () => {
    const svc = new ClaudeHookService()
    const { sftp, fs } = createFakeSftp()
    fs.files.set(
      '/home/dev/.claude/settings.json',
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: '/usr/local/bin/my-user-hook' }]
            }
          ]
        }
      })
    )
    await svc.installRemote(sftp, '/home/dev')
    const parsed = JSON.parse(fs.files.get('/home/dev/.claude/settings.json')!)
    // Original user-authored entry survives alongside the new managed entry.
    const stopDefs = parsed.hooks.Stop as { hooks: { command: string }[] }[]
    const userCmds = stopDefs.flatMap((d) => d.hooks.map((h) => h.command))
    expect(userCmds).toContain('/usr/local/bin/my-user-hook')
    expect(userCmds.some((c) => c.includes('claude-hook.sh'))).toBe(true)
  })
})
