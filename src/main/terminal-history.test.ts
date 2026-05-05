/* eslint-disable max-lines -- Why: history scoping touches shell detection, env
injection, fallback patching, WSL translation, cleanup, and GC with a TOCTOU age
guard — covering each path in one test file keeps assertions co-located with the
shared mock harness rather than splitting across files. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  existsSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  readFileSyncMock,
  rmSyncMock,
  readdirSyncMock,
  statSyncMock,
  getPathMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  getPathMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock,
  readdirSync: readdirSyncMock,
  statSync: statSyncMock
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

const { parseWslPathMock, toLinuxPathMock } = vi.hoisted(() => ({
  parseWslPathMock: vi.fn((_path: string) => null as { distro: string; linuxPath: string } | null),
  toLinuxPathMock: vi.fn((p: string) => p)
}))

vi.mock('./wsl', () => ({
  parseWslPath: parseWslPathMock,
  toLinuxPath: toLinuxPathMock
}))

import {
  resolveShellKind,
  hashWorktreeId,
  ensureHistoryDir,
  injectHistoryEnv,
  updateHistFileForFallback,
  deleteWorktreeHistoryDir,
  runHistoryGc
} from './terminal-history'

describe('terminal-history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPathMock.mockReturnValue('/fake/userData')
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ isDirectory: () => true, size: 100 })
  })

  describe('resolveShellKind', () => {
    it('detects zsh', () => {
      expect(resolveShellKind('/bin/zsh')).toBe('zsh')
    })

    it('detects bash', () => {
      expect(resolveShellKind('/bin/bash')).toBe('bash')
    })

    it('detects versioned bash (bash-5.2)', () => {
      expect(resolveShellKind('/usr/local/bin/bash-5.2')).toBe('bash')
    })

    it('detects versioned zsh (zsh-5.9)', () => {
      expect(resolveShellKind('/usr/local/bin/zsh-5.9')).toBe('zsh')
    })

    it('detects nix-store zsh path', () => {
      expect(resolveShellKind('/nix/store/abc123/bin/zsh')).toBe('zsh')
    })

    it('detects fish', () => {
      expect(resolveShellKind('/usr/bin/fish')).toBe('fish')
    })

    it('detects pwsh', () => {
      expect(resolveShellKind('pwsh')).toBe('pwsh')
      expect(resolveShellKind('pwsh.exe')).toBe('pwsh')
    })

    it('detects cmd.exe', () => {
      expect(resolveShellKind('cmd.exe')).toBe('cmd')
    })

    it('returns unknown for unrecognized shells', () => {
      expect(resolveShellKind('/bin/tcsh')).toBe('unknown')
      expect(resolveShellKind('/bin/dash')).toBe('unknown')
      expect(resolveShellKind('/bin/elvish')).toBe('unknown')
    })
  })

  describe('hashWorktreeId', () => {
    it('produces deterministic output for the same input', () => {
      const a = hashWorktreeId('repo-1::/Users/foo/worktree-a')
      const b = hashWorktreeId('repo-1::/Users/foo/worktree-a')
      expect(a).toBe(b)
    })

    it('produces different output for different inputs', () => {
      const a = hashWorktreeId('repo-1::/Users/foo/worktree-a')
      const b = hashWorktreeId('repo-1::/Users/foo/worktree-b')
      expect(a).not.toBe(b)
    })

    it('produces a 16-character hex string', () => {
      const hash = hashWorktreeId('repo-1::/Users/foo/worktree-a')
      expect(hash).toMatch(/^[0-9a-f]{16}$/)
    })
  })

  describe('ensureHistoryDir', () => {
    it('creates directory with mode 0o700', () => {
      ensureHistoryDir('abcdef0123456789')
      expect(mkdirSyncMock).toHaveBeenCalledWith(
        '/fake/userData/terminal-history/abcdef0123456789',
        { recursive: true, mode: 0o700 }
      )
    })

    it('returns null on mkdir failure', () => {
      mkdirSyncMock.mockImplementation(() => {
        throw new Error('permission denied')
      })
      const result = ensureHistoryDir('abcdef0123456789')
      expect(result).toBeNull()
    })
  })

  describe('injectHistoryEnv', () => {
    it('injects HISTFILE for zsh', () => {
      mkdirSyncMock.mockReturnValue(undefined)

      const env: Record<string, string> = {}
      const result = injectHistoryEnv(env, 'repo-1::/path/wt', '/bin/zsh', '/path/wt')

      expect(result.shell).toBe('zsh')
      expect(result.histFile).toContain('terminal-history')
      expect(result.histFile).toContain('zsh_history')
      expect(env.HISTFILE).toBe(result.histFile)
    })

    it('injects HISTFILE for bash', () => {
      mkdirSyncMock.mockReturnValue(undefined)

      const env: Record<string, string> = {}
      const result = injectHistoryEnv(env, 'repo-1::/path/wt', '/bin/bash', '/path/wt')

      expect(result.shell).toBe('bash')
      expect(result.histFile).toContain('bash_history')
      expect(env.HISTFILE).toBe(result.histFile)
    })

    it('produces different HISTFILE for different worktreeIds', () => {
      mkdirSyncMock.mockReturnValue(undefined)
      existsSyncMock.mockReturnValue(true)

      const envA: Record<string, string> = {}
      injectHistoryEnv(envA, 'repo-1::/path/wt-a', '/bin/zsh', '/path/wt-a')

      const envB: Record<string, string> = {}
      injectHistoryEnv(envB, 'repo-1::/path/wt-b', '/bin/zsh', '/path/wt-b')

      expect(envA.HISTFILE).not.toBe(envB.HISTFILE)
    })

    it('preserves caller-provided HISTFILE (check-before-set)', () => {
      const env: Record<string, string> = { HISTFILE: '/my/custom/histfile' }
      const result = injectHistoryEnv(env, 'repo-1::/path/wt', '/bin/zsh', '/path/wt')

      expect(env.HISTFILE).toBe('/my/custom/histfile')
      expect(result.histFile).toBeNull()
    })

    it('does not inject HISTFILE for unknown shells', () => {
      const env: Record<string, string> = {}
      const result = injectHistoryEnv(env, 'repo-1::/path/wt', '/bin/tcsh', '/path/wt')

      expect(env.HISTFILE).toBeUndefined()
      expect(result.shell).toBe('unknown')
      expect(result.histFile).toBeNull()
    })

    it('does not inject HISTFILE for cmd.exe', () => {
      const env: Record<string, string> = {}
      const result = injectHistoryEnv(env, 'repo-1::/path/wt', 'cmd.exe', '/path/wt')

      expect(env.HISTFILE).toBeUndefined()
      expect(result.shell).toBe('cmd')
      expect(result.histFile).toBeNull()
    })

    it('does not inject HISTFILE for fish (Phase 2)', () => {
      const env: Record<string, string> = {}
      const result = injectHistoryEnv(env, 'repo-1::/path/wt', '/usr/bin/fish', '/path/wt')

      expect(env.HISTFILE).toBeUndefined()
      expect(result.shell).toBe('fish')
    })

    it('degrades gracefully when directory creation fails', () => {
      mkdirSyncMock.mockImplementation(() => {
        throw new Error('disk full')
      })

      const env: Record<string, string> = {}
      const result = injectHistoryEnv(env, 'repo-1::/path/wt', '/bin/zsh', '/path/wt')

      expect(env.HISTFILE).toBeUndefined()
      expect(result.histFile).toBeNull()
    })
  })

  describe('updateHistFileForFallback', () => {
    it('updates HISTFILE to match fallback shell', () => {
      const env: Record<string, string> = {
        HISTFILE: '/fake/userData/terminal-history/abc123/zsh_history'
      }
      updateHistFileForFallback(env, '/bin/bash')
      expect(env.HISTFILE).toBe('/fake/userData/terminal-history/abc123/bash_history')
    })

    it('removes HISTFILE for unknown fallback shell', () => {
      const env: Record<string, string> = {
        HISTFILE: '/fake/userData/terminal-history/abc123/zsh_history'
      }
      updateHistFileForFallback(env, '/bin/sh')
      expect(env.HISTFILE).toBeUndefined()
    })

    it('is a no-op when HISTFILE is not set', () => {
      const env: Record<string, string> = {}
      updateHistFileForFallback(env, '/bin/bash')
      expect(env.HISTFILE).toBeUndefined()
    })
  })

  describe('deleteWorktreeHistoryDir', () => {
    it('removes the history directory for a worktree', () => {
      existsSyncMock.mockReturnValue(true)
      deleteWorktreeHistoryDir('repo-1::/path/wt')
      expect(rmSyncMock).toHaveBeenCalledWith(expect.stringContaining('terminal-history'), {
        recursive: true,
        force: true
      })
    })

    it('does not throw on deletion failure', () => {
      existsSyncMock.mockReturnValue(true)
      rmSyncMock.mockImplementation(() => {
        throw new Error('permission denied')
      })
      expect(() => deleteWorktreeHistoryDir('repo-1::/path/wt')).not.toThrow()
    })
  })

  describe('runHistoryGc', () => {
    it('prunes orphaned directories', () => {
      existsSyncMock.mockImplementation((p: string) => {
        // WSL root doesn't exist, so GC skips it
        if (p.includes('terminal-history-wsl')) {
          return false
        }
        return true
      })
      readdirSyncMock.mockImplementation((dir: string) => {
        if (dir.endsWith('terminal-history')) {
          return ['dir1', 'dir2']
        }
        return ['meta.json']
      })
      statSyncMock.mockReturnValue({ isDirectory: () => true, size: 100 })
      readFileSyncMock.mockImplementation((p: string) => {
        // Use a createdAt old enough to pass the GC age threshold
        const oldDate = new Date(Date.now() - 10 * 60 * 1000).toISOString()
        if (p.includes('dir1')) {
          return JSON.stringify({ worktreeId: 'live-wt', createdAt: oldDate })
        }
        return JSON.stringify({ worktreeId: 'dead-wt', createdAt: oldDate })
      })

      const liveIds = new Set(['live-wt'])
      runHistoryGc(liveIds)

      // Should only prune dir2 (dead-wt), not dir1 (live-wt)
      expect(rmSyncMock).toHaveBeenCalledTimes(1)
      expect(rmSyncMock).toHaveBeenCalledWith(expect.stringContaining('dir2'), {
        recursive: true,
        force: true
      })
    })

    it('skips recently-created directories to avoid TOCTOU race', () => {
      existsSyncMock.mockImplementation((p: string) => {
        if (p.includes('terminal-history-wsl')) {
          return false
        }
        return true
      })
      readdirSyncMock.mockImplementation((dir: string) => {
        if (dir.endsWith('terminal-history')) {
          return ['fresh-dir']
        }
        return ['meta.json']
      })
      statSyncMock.mockReturnValue({ isDirectory: () => true, size: 100 })
      // createdAt is just now — younger than the 5-minute GC threshold
      readFileSyncMock.mockReturnValue(
        JSON.stringify({ worktreeId: 'unknown-wt', createdAt: new Date().toISOString() })
      )

      runHistoryGc(new Set())

      // Should NOT prune because the directory is too young
      expect(rmSyncMock).not.toHaveBeenCalled()
    })

    it('does not throw when history root does not exist', () => {
      existsSyncMock.mockReturnValue(false)
      expect(() => runHistoryGc(new Set())).not.toThrow()
      expect(readdirSyncMock).not.toHaveBeenCalled()
    })
  })

  describe('WSL path conversion', () => {
    it('converts HISTFILE to Linux path for WSL cwd', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

      try {
        parseWslPathMock.mockReturnValue({ distro: 'Ubuntu', linuxPath: '/home/user/project' })
        toLinuxPathMock.mockReturnValue(
          '/mnt/c/Users/user/AppData/Roaming/Orca/terminal-history-wsl/Ubuntu/abc123/bash_history'
        )
        mkdirSyncMock.mockReturnValue(undefined)
        existsSyncMock.mockReturnValue(true)

        const env: Record<string, string> = {}
        const result = injectHistoryEnv(
          env,
          'repo-1::/wsl/path',
          '/bin/bash',
          '\\\\wsl.localhost\\Ubuntu\\home\\user\\project'
        )

        expect(toLinuxPathMock).toHaveBeenCalled()
        expect(result.histFile).toContain('/mnt/')
        expect(env.HISTFILE).toBe(result.histFile)
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      }
    })

    it('stores WSL history under terminal-history-wsl/<distro>/', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

      try {
        parseWslPathMock.mockReturnValue({ distro: 'Ubuntu', linuxPath: '/home/user' })
        toLinuxPathMock.mockImplementation((p: string) => p)
        mkdirSyncMock.mockReturnValue(undefined)
        existsSyncMock.mockReturnValue(true)

        const env: Record<string, string> = {}
        injectHistoryEnv(
          env,
          'repo-1::/wsl/path',
          '/bin/bash',
          '\\\\wsl.localhost\\Ubuntu\\home\\user'
        )

        expect(mkdirSyncMock).toHaveBeenCalledWith(
          expect.stringContaining('terminal-history-wsl/Ubuntu'),
          expect.any(Object)
        )
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      }
    })
  })
})
