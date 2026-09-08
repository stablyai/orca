import type * as FsPromises from 'node:fs/promises'
import { sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'

const {
  existsSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  readFileSyncMock,
  lstatSyncMock,
  rmSyncMock,
  renameSyncMock,
  readdirSyncMock,
  statSyncMock,
  openSyncMock,
  fstatSyncMock,
  closeSyncMock,
  getPathMock,
  rmAsyncMock,
  deleteWslFishHistoryFileMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  lstatSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
  renameSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  openSyncMock: vi.fn((_path?: string | Buffer) => 1),
  fstatSyncMock: vi.fn(() => ({
    dev: 1n,
    ino: 2n,
    birthtimeNs: 3n,
    isFile: () => true,
    isDirectory: () => true
  })),
  closeSyncMock: vi.fn(),
  getPathMock: vi.fn(),
  rmAsyncMock: vi.fn(async () => undefined),
  deleteWslFishHistoryFileMock: vi.fn(async () => undefined)
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  readFileSync: readFileSyncMock,
  lstatSync: lstatSyncMock,
  rmSync: rmSyncMock,
  renameSync: renameSyncMock,
  readdirSync: readdirSyncMock,
  statSync: statSyncMock,
  openSync: openSyncMock,
  fstatSync: fstatSyncMock,
  closeSync: closeSyncMock
}))

// Spread the real module: this factory replaces node:fs/promises for the whole import graph, so a
// transitive readFile/mkdir would otherwise resolve to undefined.
vi.mock('node:fs/promises', async () => ({
  ...(await vi.importActual<typeof FsPromises>('node:fs/promises')),
  rm: rmAsyncMock
}))

const { parseWslPathMock, toLinuxPathMock } = vi.hoisted(() => ({
  parseWslPathMock: vi.fn((_path: string) => null as { distro: string; linuxPath: string } | null),
  toLinuxPathMock: vi.fn((p: string) => p)
}))

vi.mock('./wsl', () => ({
  parseWslPath: parseWslPathMock,
  toLinuxPath: toLinuxPathMock
}))

vi.mock('./wsl-fish-history-cleanup', () => ({
  deleteWslFishHistoryFile: deleteWslFishHistoryFileMock
}))

import {
  resolveShellKind,
  ensureHistoryDir,
  injectHistoryEnv,
  injectWslFishHistoryEnv,
  MAX_HISTORY_META_BYTES,
  updateHistoryEnvForFallback,
  type HistoryInjectionResult
} from './terminal-history'
import { fishHistorySessionName, relayFishHistorySessionName } from './fish-history-session'
import { hashWorktreeId } from './terminal-history-paths'
import {
  cancelPendingHistoryTreeRemovalRetries,
  deleteWorktreeHistoryDir,
  flushPendingWorktreeHistoryDeletions
} from './terminal-history-deletion'

const OTHER_WORKTREE_HASH = hashWorktreeId('repo-1::/path/other-wt')

describe('terminal-history', () => {
  afterEach(() => {
    cancelPendingHistoryTreeRemovalRetries()
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // Why: clearAllMocks keeps implementations, so a throwing rename from one test would leak forward.
    renameSyncMock.mockReset()
    readFileSyncMock.mockReset()
    readdirSyncMock.mockReset()
    rmAsyncMock.mockReset()
    rmAsyncMock.mockResolvedValue(undefined)
    getPathMock.mockReturnValue('/fake/userData')
    installFakeAppEnvironment({ getPath: getPathMock })
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ isDirectory: () => true, size: 100 })
    openSyncMock.mockImplementation(() => 1)
    fstatSyncMock.mockReturnValue({
      dev: 1n,
      ino: 2n,
      birthtimeNs: 3n,
      isFile: () => true,
      isDirectory: () => true
    })
    lstatSyncMock.mockReturnValue({
      dev: 1n,
      ino: 2n,
      birthtimeNs: 3n,
      size: 100,
      isDirectory: () => true,
      isFile: () => true,
      isSymbolicLink: () => false
    })
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
        expect.stringMatching(/[\\/]fake[\\/]userData[\\/]terminal-history[\\/]abcdef0123456789$/),
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

    it('scopes fish by session name instead of HISTFILE, which fish ignores', () => {
      const env: Record<string, string> = {}
      const result = injectHistoryEnv(env, 'repo-1::/path/wt', '/usr/bin/fish', '/path/wt')

      expect(env.HISTFILE).toBeUndefined()
      expect(result.shell).toBe('fish')
      expect(result.fishSession).toBe(fishHistorySessionName(hashWorktreeId('repo-1::/path/wt')))
      expect(env.fish_history).toBe(result.fishSession)
      // Deletion can only find the out-of-tree fish file through this record.
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        expect.stringContaining('meta.json'),
        expect.stringContaining(`"fishSession":"${result.fishSession}"`),
        expect.anything()
      )
    })

    it('records the history DIRECTORY from the SPAWN env, not this process env', () => {
      // The file is written by the PTY's fish, and the two envs disagree whenever
      // Orca was launched with a different XDG_DATA_HOME than the shells it spawns.
      // Pinned so the assertion cannot accidentally read the developer's own value.
      const originalDataHome = process.env.XDG_DATA_HOME
      process.env.XDG_DATA_HOME = ['', 'main', 'process', 'data'].join(sep)
      try {
        const env: Record<string, string> = { XDG_DATA_HOME: ['', 'spawn', 'data'].join(sep) }
        injectHistoryEnv(env, 'repo-1::/path/wt', '/usr/bin/fish', '/path/wt')
        const meta = JSON.parse(writeFileSyncMock.mock.calls.at(-1)?.[1] as string) as Record<
          string,
          string
        >

        expect(meta.fishHistoryDir).toBe(['', 'spawn', 'data', 'fish'].join(sep))
      } finally {
        if (originalDataHome === undefined) {
          delete process.env.XDG_DATA_HOME
        } else {
          process.env.XDG_DATA_HOME = originalDataHome
        }
      }
    })

    it('replaces oversized metadata without parsing it', () => {
      statSyncMock.mockReturnValue({ isDirectory: () => true, size: MAX_HISTORY_META_BYTES + 1 })
      const env = { XDG_DATA_HOME: ['', 'active'].join(sep) }

      injectHistoryEnv(env, 'repo-1::/path/wt', '/usr/bin/fish', '/path/wt')

      expect(readFileSyncMock).not.toHaveBeenCalled()
      const meta = JSON.parse(writeFileSyncMock.mock.calls.at(-1)?.[1] as string) as Record<
        string,
        string
      >
      expect(meta.fishHistoryDir).toBe(['', 'active', 'fish'].join(sep))
    })

    it('gives two fish worktrees different history sessions', () => {
      const envA: Record<string, string> = {}
      injectHistoryEnv(envA, 'repo-1::/path/wt-a', '/usr/bin/fish', '/path/wt-a')
      const envB: Record<string, string> = {}
      injectHistoryEnv(envB, 'repo-1::/path/wt-b', '/usr/bin/fish', '/path/wt-b')

      expect(envA.fish_history).not.toBe(envB.fish_history)
    })

    it('drops an ORCA_HISTFILE inherited from a parent Orca PTY', () => {
      // Why: an Orca terminal opened from inside another Orca terminal inherits
      // it, and the zsh wrapper would then re-export the PARENT worktree's
      // history path here. Credit: caught by @innocarpe in #11146.
      const env: Record<string, string> = {
        ORCA_HISTFILE: ['', 'other', 'wt', 'zsh_history'].join(sep)
      }

      injectHistoryEnv(env, 'repo-1::/path/wt', '/bin/zsh', '/path/wt')

      expect(env.ORCA_HISTFILE).toBe(env.HISTFILE)
      expect(env.ORCA_HISTFILE).not.toContain('other')
    })

    it('drops an inherited ORCA_HISTFILE even when it injects nothing', () => {
      // The dangerous variant: the early return would otherwise leave the stale
      // value pointing the wrapper at another worktree, overriding HISTFILE.
      const env: Record<string, string> = {
        HISTFILE: ['', 'mine', 'zsh_history'].join(sep),
        ORCA_HISTFILE: ['', 'other', 'wt', 'zsh_history'].join(sep)
      }

      injectHistoryEnv(env, 'repo-1::/path/wt', '/bin/zsh', '/path/wt')

      expect(env.HISTFILE).toBe(['', 'mine', 'zsh_history'].join(sep))
      expect(env.ORCA_HISTFILE).toBeUndefined()
    })

    it.each([
      [
        'desktop',
        ['', 'fake', 'userData', 'terminal-history', OTHER_WORKTREE_HASH, 'zsh_history'].join(sep)
      ],
      [
        'relay',
        [
          '',
          'home',
          'me',
          '.orca-remote',
          'terminal-history',
          `${OTHER_WORKTREE_HASH}-zsh_history`
        ].join(sep)
      ]
    ])('drops a %s HISTFILE inherited from a parent Orca pane', (_kind, inherited) => {
      // HISTFILE stays EXPORTED once the wrapper restores it, so an Orca launched
      // from a pane in another worktree would otherwise hit the check-before-set
      // early return in EVERY pane and append into that one worktree's file.
      const env: Record<string, string> = { HISTFILE: inherited }

      const result = injectHistoryEnv(env, 'repo-1::/path/wt', '/bin/zsh', '/path/wt')

      expect(result.histFile).toBe(env.HISTFILE)
      expect(env.HISTFILE).toContain(hashWorktreeId('repo-1::/path/wt'))
      expect(env.HISTFILE).not.toContain(OTHER_WORKTREE_HASH)
    })

    it.each([
      ['an ordinary path', ['', 'home', 'me', '.zsh_history'].join(sep)],
      // Orca only ever mints absolute paths, so the same shape relative to the
      // user's cwd is theirs.
      [
        'a relative path of Orca’s shape',
        ['terminal-history', OTHER_WORKTREE_HASH, 'zsh_history'].join(sep)
      ]
    ])('preserves %s the user set as HISTFILE', (_kind, histFile) => {
      // Only a path Orca minted is droppable; everything else is the user's.
      const env: Record<string, string> = { HISTFILE: histFile }

      const result = injectHistoryEnv(env, 'repo-1::/path/wt', '/bin/zsh', '/path/wt')

      expect(env.HISTFILE).toBe(histFile)
      expect(result.histFile).toBeNull()
    })

    it('preserves a caller-supplied fish_history', () => {
      const env: Record<string, string> = { fish_history: 'mine' }
      const result = injectHistoryEnv(env, 'repo-1::/path/wt', '/usr/bin/fish', '/path/wt')

      expect(env.fish_history).toBe('mine')
      expect(result.fishSession).toBeNull()
    })

    it.each([
      ['desktop', fishHistorySessionName(hashWorktreeId('repo-1::/path/other-wt'))],
      ['relay', relayFishHistorySessionName(hashWorktreeId('repo-1::/path/other-wt'))]
    ])('replaces a %s fish_history inherited from a parent Orca', (_kind, inherited) => {
      // fish EXPORTS fish_history, so an Orca launched from a fish pane hands the
      // LAUNCHING worktree's session to every pane here — panes in every other
      // worktree included, which would all then write one worktree's history file.
      const env: Record<string, string> = { fish_history: inherited }

      const result = injectHistoryEnv(env, 'repo-1::/path/wt', '/usr/bin/fish', '/path/wt')

      expect(result.fishSession).toBe(fishHistorySessionName(hashWorktreeId('repo-1::/path/wt')))
      expect(env.fish_history).toBe(result.fishSession)
    })

    it('drops an inherited fish_history even when the shell is not fish', () => {
      // A fish started by hand inside this zsh pane must not adopt the parent's session.
      const env: Record<string, string> = {
        fish_history: fishHistorySessionName(hashWorktreeId('repo-1::/path/other-wt'))
      }

      injectHistoryEnv(env, 'repo-1::/path/wt', '/bin/zsh', '/path/wt')

      expect(env.fish_history).toBeUndefined()
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

  describe('injectWslFishHistoryEnv', () => {
    // clearAllMocks keeps implementations: drop the throwing mkdir left by the degrade test.
    beforeEach(() => {
      mkdirSyncMock.mockReset()
    })

    it('replaces an inherited Orca fish_history with this worktree session', () => {
      const env: Record<string, string> = {
        fish_history: fishHistorySessionName(hashWorktreeId('repo-1::/path/other-wt'))
      }

      const session = injectWslFishHistoryEnv(env, 'repo-1::/path/wt', 'Ubuntu')

      expect(session).toBe(fishHistorySessionName(hashWorktreeId('repo-1::/path/wt')))
      expect(env.fish_history).toBe(session)
    })

    it('preserves a caller-supplied fish_history', () => {
      const env: Record<string, string> = { fish_history: 'mine' }

      expect(injectWslFishHistoryEnv(env, 'repo-1::/path/wt', 'Ubuntu')).toBeNull()
      expect(env.fish_history).toBe('mine')
    })
  })

  describe('updateHistoryEnvForFallback', () => {
    const zshInjection = (): HistoryInjectionResult => ({
      shell: 'zsh',
      histFile: '/fake/userData/terminal-history/abc123/zsh_history',
      fishSession: null,
      historyDir: '/fake/userData/terminal-history/abc123'
    })

    it('updates HISTFILE to match fallback shell', () => {
      const env: Record<string, string> = {
        HISTFILE: '/fake/userData/terminal-history/abc123/zsh_history'
      }
      updateHistoryEnvForFallback(env, '/bin/bash', zshInjection())
      expect(env.HISTFILE).toBe('/fake/userData/terminal-history/abc123/bash_history')
    })

    it('removes HISTFILE for unknown fallback shell', () => {
      const env: Record<string, string> = {
        HISTFILE: '/fake/userData/terminal-history/abc123/zsh_history'
      }
      updateHistoryEnvForFallback(env, '/bin/sh', zshInjection())
      expect(env.HISTFILE).toBeUndefined()
    })

    it('is a no-op when nothing was injected', () => {
      const env: Record<string, string> = {}
      updateHistoryEnvForFallback(env, '/bin/bash', {
        shell: 'unknown',
        histFile: null,
        fishSession: null,
        historyDir: null
      })
      expect(env.HISTFILE).toBeUndefined()
    })

    it('swaps an injected fish session for the fallback shell HISTFILE', () => {
      const env: Record<string, string> = { fish_history: 'orca_abc123' }
      updateHistoryEnvForFallback(env, '/bin/bash', {
        shell: 'fish',
        histFile: null,
        fishSession: 'orca_abc123',
        historyDir: '/fake/userData/terminal-history/abc123'
      })
      expect(env.fish_history).toBeUndefined()
      expect(env.HISTFILE).toBe('/fake/userData/terminal-history/abc123/bash_history')
    })

    it('keeps a caller-supplied fish_history the injection never claimed', () => {
      const env: Record<string, string> = { fish_history: 'mine' }
      updateHistoryEnvForFallback(env, '/bin/bash', zshInjection())
      expect(env.fish_history).toBe('mine')
    })
  })

  describe('deleteWorktreeHistoryDir', () => {
    const worktreeId = 'repo-1::/path/wt'
    const session = fishHistorySessionName(hashWorktreeId(worktreeId))
    const historyFilename = `${session}_history`

    it('tombstones then async-removes the history directory without recursive rmSync', async () => {
      existsSyncMock.mockReturnValue(true)
      deleteWorktreeHistoryDir('repo-1::/path/wt')
      expect(renameSyncMock).toHaveBeenCalled()
      expect(rmSyncMock).not.toHaveBeenCalled()
      expect(rmAsyncMock).toHaveBeenCalledWith(
        expect.stringContaining('.pending-delete'),
        expect.objectContaining({ recursive: true, force: true })
      )
      await flushPendingWorktreeHistoryDeletions()
    })

    it('deletes the fish history file in the directory meta.json recorded', async () => {
      const recordedDir = ['', 'spawn', 'data', 'fish'].join(sep)
      existsSyncMock.mockReturnValue(true)
      lstatSyncMock.mockReturnValue({ isFile: () => true })
      readFileSyncMock.mockReturnValue(
        JSON.stringify({ worktreeId, fishSession: session, fishHistoryDir: recordedDir })
      )

      deleteWorktreeHistoryDir('repo-1::/path/wt')

      expect(rmSyncMock).toHaveBeenCalledWith([recordedDir, historyFilename].join(sep))
      await flushPendingWorktreeHistoryDeletions()
    })

    it('also tries this process fish dir, for meta written before that field', async () => {
      const originalDataHome = process.env.XDG_DATA_HOME
      process.env.XDG_DATA_HOME = ['', 'main', 'data'].join(sep)
      try {
        existsSyncMock.mockReturnValue(true)
        lstatSyncMock.mockReturnValue({ isFile: () => true })
        readFileSyncMock.mockReturnValue(JSON.stringify({ worktreeId, fishSession: session }))

        deleteWorktreeHistoryDir('repo-1::/path/wt')

        expect(rmSyncMock).toHaveBeenCalledWith(
          ['', 'main', 'data', 'fish', historyFilename].join(sep)
        )
      } finally {
        if (originalDataHome === undefined) {
          delete process.env.XDG_DATA_HOME
        } else {
          process.env.XDG_DATA_HOME = originalDataHome
        }
      }
      await flushPendingWorktreeHistoryDeletions()
    })

    it('ignores a fishSession that does not belong to this history directory', async () => {
      // Why: the session name is re-derived from the directory's own hash, so a
      // tampered meta.json naming someone else's session cannot steer the delete.
      existsSyncMock.mockReturnValue(true)
      lstatSyncMock.mockReturnValue({ isFile: () => true })
      readFileSyncMock.mockReturnValue(
        JSON.stringify({ worktreeId, fishSession: 'orca_deadbeefdeadbeef' })
      )

      deleteWorktreeHistoryDir('repo-1::/path/wt')

      expect(rmSyncMock).not.toHaveBeenCalledWith(expect.stringContaining('orca_deadbeefdeadbeef'))
      await flushPendingWorktreeHistoryDeletions()
    })

    it('refuses to unlink a fish history path that is not a regular file', async () => {
      existsSyncMock.mockReturnValue(true)
      lstatSyncMock.mockReturnValue({ isFile: () => false })
      readFileSyncMock.mockReturnValue(JSON.stringify({ worktreeId, fishSession: session }))

      deleteWorktreeHistoryDir('repo-1::/path/wt')

      expect(rmSyncMock).not.toHaveBeenCalled()
      await flushPendingWorktreeHistoryDeletions()
    })

    it('cleans WSL Fish history through the owning distro before removing metadata', async () => {
      readFileSyncMock.mockReturnValue(JSON.stringify({ worktreeId, fishSession: session }))
      readdirSyncMock.mockImplementation((path: string) => {
        if (path.endsWith('terminal-history-wsl')) {
          return ['Ubuntu']
        }
        return []
      })

      deleteWorktreeHistoryDir(worktreeId)
      await flushPendingWorktreeHistoryDeletions()

      expect(deleteWslFishHistoryFileMock).toHaveBeenCalledWith('Ubuntu', session)
    })

    it('leaves the live directory alone when the tombstone rename fails', async () => {
      existsSyncMock.mockReturnValue(true)
      renameSyncMock.mockImplementation(() => {
        throw new Error('permission denied')
      })

      expect(() => deleteWorktreeHistoryDir('repo-1::/path/wt')).not.toThrow()

      // Why: a path-derived worktree ID can be recreated at the same path, so an async rm aimed at the
      // live directory could delete a freshly recreated worktree's history. GC reclaims it instead.
      expect(rmAsyncMock).not.toHaveBeenCalled()
      expect(rmSyncMock).not.toHaveBeenCalled()
      await flushPendingWorktreeHistoryDeletions()
    })

    it('does not throw when the async removal itself fails', async () => {
      existsSyncMock.mockReturnValue(true)
      rmAsyncMock.mockRejectedValueOnce(new Error('async fail'))
      expect(() => deleteWorktreeHistoryDir('repo-1::/path/wt')).not.toThrow()
      await expect(flushPendingWorktreeHistoryDeletions()).resolves.toBeUndefined()
    })

    it('retries pending tombstones on flush after a failed async rm (app-quit durability)', async () => {
      let leftoverTombstonePresent = true
      existsSyncMock.mockImplementation((p: string) => {
        const path = String(p)
        if (path.includes('.pending-delete') && !path.endsWith('.pending-delete')) {
          return true
        }
        if (path.endsWith('terminal-history') || path.endsWith('.pending-delete')) {
          return true
        }
        return path.includes(hashWorktreeId('repo-1::/path/wt'))
      })
      readdirSyncMock.mockImplementation((p: string) => {
        if (String(p).endsWith('.pending-delete')) {
          return leftoverTombstonePresent ? ['leftover-tombstone'] : []
        }
        return []
      })
      rmAsyncMock.mockImplementation(async () => {
        leftoverTombstonePresent = false
      })
      await flushPendingWorktreeHistoryDeletions()
      expect(rmAsyncMock).toHaveBeenCalledWith(
        expect.stringContaining('leftover-tombstone'),
        expect.objectContaining({ recursive: true, force: true })
      )
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
          expect.stringMatching(/[\\/]terminal-history-wsl[\\/]Ubuntu[\\/]/),
          expect.any(Object)
        )
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      }
    })

    it('uses the project WSL distro hint when cwd is a Windows path', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

      try {
        parseWslPathMock.mockReturnValue(null)
        toLinuxPathMock.mockImplementation((p: string) => p.replace(/^C:\\/i, '/mnt/c/'))
        mkdirSyncMock.mockReturnValue(undefined)
        existsSyncMock.mockReturnValue(true)
        getPathMock.mockReturnValue('C:\\Users\\alice\\AppData\\Roaming\\Orca')

        const env: Record<string, string> = {}
        const result = injectHistoryEnv(env, 'repo-1::C:\\repo', '/bin/bash', 'C:\\repo', {
          wslDistro: 'Ubuntu'
        })

        expect(mkdirSyncMock).toHaveBeenCalledWith(
          expect.stringMatching(/[\\/]terminal-history-wsl[\\/]Ubuntu[\\/]/),
          expect.any(Object)
        )
        expect(toLinuxPathMock).toHaveBeenCalled()
        expect(result.histFile).toMatch(/^\/mnt\/c\//)
        expect(env.HISTFILE).toBe(result.histFile)
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      }
    })
  })
})
