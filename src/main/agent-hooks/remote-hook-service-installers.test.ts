import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

import { CodexHookService } from '../codex/hook-service'
import { CursorHookService } from '../cursor/hook-service'
import { GeminiHookService } from '../gemini/hook-service'
import { ClaudeHookService } from '../claude/hook-service'
import { GrokHookService } from '../grok/hook-service'

type FakeFs = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
  failRenameTo: Set<string>
}

function createFakeSftp(): { sftp: SFTPWrapper; fs: FakeFs } {
  const fs: FakeFs = {
    files: new Map(),
    dirs: new Set(['/']),
    modes: new Map(),
    failRenameTo: new Set()
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

describe('remote hook service installers', () => {
  it('always writes POSIX scripts for SSH remotes even from a Windows host', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const installers = [
        {
          path: '/home/dev/.orca/agent-hooks/claude-hook.sh',
          install: (sftp: SFTPWrapper) => new ClaudeHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/codex-hook.sh',
          install: (sftp: SFTPWrapper) => new CodexHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/gemini-hook.sh',
          install: (sftp: SFTPWrapper) => new GeminiHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/cursor-hook.sh',
          install: (sftp: SFTPWrapper) => new CursorHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/grok-hook.sh',
          install: (sftp: SFTPWrapper) => new GrokHookService().installRemote(sftp, '/home/dev')
        }
      ]

      for (const { install, path } of installers) {
        const { sftp, fs } = createFakeSftp()
        const status = await install(sftp)
        expect(status.state).toBe('installed')
        const script = fs.files.get(path)
        expect(script).toMatch(/^#!\/bin\/sh\n/)
        expect(script).not.toContain('@echo off')
        expect(script).not.toContain('powershell -NoProfile')
      }
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('installs remote Codex hooks with matching trust entries', async () => {
    const { sftp, fs } = createFakeSftp()

    const status = await new CodexHookService().installRemote(sftp, '/home/dev/')

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe('/home/dev/.codex/hooks.json')
    const hooks = JSON.parse(fs.files.get('/home/dev/.codex/hooks.json')!) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    for (const eventName of [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'Stop'
    ]) {
      const command = hooks.hooks[eventName]?.[0]?.hooks?.[0]?.command
      expect(command).toContain('/home/dev/.orca/agent-hooks/codex-hook.sh')
      expect(command).toMatch(/^if \[ -x /)
    }
    expect(fs.files.get('/home/dev/.orca/agent-hooks/codex-hook.sh')).toContain('#!/bin/sh')
    expect(fs.modes.get('/home/dev/.orca/agent-hooks/codex-hook.sh')).toBe(0o755)
    const toml = fs.files.get('/home/dev/.codex/config.toml')
    expect(toml).toContain('/home/dev/.codex/hooks.json:permission_request:0:0')
    expect(toml).toContain('trusted_hash = "sha256:')
  })

  it('reports Codex trust-write failures without rolling back installed hooks', async () => {
    const { sftp, fs } = createFakeSftp()
    fs.failRenameTo.add('/home/dev/.codex/config.toml')

    const status = await new CodexHookService().installRemote(sftp, '/home/dev')

    expect(status.state).toBe('error')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toContain('trust entries could not be written')
    expect(fs.files.get('/home/dev/.codex/hooks.json')).toContain('codex-hook.sh')
    expect(fs.files.get('/home/dev/.orca/agent-hooks/codex-hook.sh')).toContain('#!/bin/sh')
  })

  it('installs remote Gemini, Cursor, and Grok configs using their CLI-specific schemas', async () => {
    const gemini = createFakeSftp()
    const cursor = createFakeSftp()
    const grok = createFakeSftp()

    await new GeminiHookService().installRemote(gemini.sftp, '/home/dev')
    await new CursorHookService().installRemote(cursor.sftp, '/home/dev')
    await new GrokHookService().installRemote(grok.sftp, '/home/dev')

    const geminiConfig = JSON.parse(gemini.fs.files.get('/home/dev/.gemini/settings.json')!) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    for (const eventName of ['BeforeAgent', 'AfterAgent', 'AfterTool', 'PreToolUse']) {
      const command = geminiConfig.hooks[eventName]?.[0]?.hooks?.[0]?.command
      expect(command).toContain('/home/dev/.orca/agent-hooks/gemini-hook.sh')
      expect(command).toMatch(/^if \[ -x /)
    }

    const cursorConfig = JSON.parse(cursor.fs.files.get('/home/dev/.cursor/hooks.json')!) as {
      version: number
      hooks: Record<string, { command?: string; hooks?: unknown[] }[]>
    }
    expect(cursorConfig.version).toBe(1)
    for (const eventName of [
      'beforeSubmitPrompt',
      'stop',
      'preToolUse',
      'postToolUse',
      'postToolUseFailure',
      'beforeShellExecution',
      'beforeMCPExecution',
      'afterAgentResponse'
    ]) {
      const definition = cursorConfig.hooks[eventName]?.[0]
      expect(definition?.command).toContain('/home/dev/.orca/agent-hooks/cursor-hook.sh')
      expect(definition?.hooks).toBeUndefined()
    }

    const grokConfig = JSON.parse(grok.fs.files.get('/home/dev/.grok/hooks/orca-status.json')!) as {
      hooks: Record<string, { matcher?: string; hooks?: { command: string }[] }[]>
    }
    for (const eventName of [
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'SessionEnd',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'Notification'
    ]) {
      const definition = grokConfig.hooks[eventName]?.[0]
      const command = definition?.hooks?.[0]?.command
      expect(command).toContain('/home/dev/.orca/agent-hooks/grok-hook.sh')
      expect(command).toMatch(/^if \[ -x /)
    }
    expect(grokConfig.hooks.PreToolUse?.[0]?.matcher).toBe('*')
  })
})
