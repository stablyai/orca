// Why: config-dir discovery decides which extra settings.json files Orca will
// write managed hooks into. The tests lock the structural naming convention,
// the stat-only privacy posture (these dirs hold credentials), and the fail-
// open behavior — all against an injected fs so the real home dir is never
// touched.
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLAUDE_CONFIG_DIR_MARKERS,
  discoverLocalClaudeConfigDirNames,
  discoverRemoteClaudeConfigDirNames,
  type LocalClaudeConfigDirFs,
  type SftpShapedClaudeConfigDirFs
} from './claude-config-dir-discovery'
import { deriveClaudeConfigDirLabel } from '../../shared/claude-config-dir-label'

const HOME = '/home/fixture'

type FakeHome = {
  fs: LocalClaudeConfigDirFs
  readdirCalls: string[]
  probedPaths: string[]
}

function createFakeHome(entries: string[], markerPaths: string[]): FakeHome {
  const readdirCalls: string[] = []
  const probedPaths: string[] = []
  const markers = new Set(markerPaths)
  return {
    readdirCalls,
    probedPaths,
    fs: {
      readdirNames: (dirPath) => {
        readdirCalls.push(dirPath)
        return [...entries]
      },
      pathIsFile: (path) => {
        probedPaths.push(path)
        return markers.has(path)
      }
    }
  }
}

function spyOnConsole(): ReturnType<typeof vi.spyOn>[] {
  return (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {})
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('discoverLocalClaudeConfigDirNames', () => {
  it('keeps only marker-backed .claude-<name>/.claude.<name> dirs', () => {
    const home = createFakeHome(
      [
        '.claude', // managed default — excluded
        '.openclaude', // managed — excluded
        '.claude-grok', // marker present — included
        '.claude.vertex', // dot separator, marker present — included
        '.claudeX', // no separator — excluded
        '.claude-empty', // matches pattern but has no marker — excluded
        '.claude-file', // a regular FILE: marker stat inside it fails — excluded
        '.config', // unrelated dot-dir — excluded
        '.ssh'
      ],
      [
        join(HOME, '.claude-grok', 'settings.json'),
        join(HOME, '.claude.vertex', '.credentials.json')
      ]
    )
    const consoleSpies = spyOnConsole()

    const discovered = discoverLocalClaudeConfigDirNames(HOME, home.fs)

    expect(discovered).toEqual(['.claude-grok', '.claude.vertex'])
    // Stat/readdir only: exactly one home listing, and every probe targets a
    // marker file inside a pattern-matching candidate — never .claude itself,
    // never a non-matching entry, and never a content read (the injected fs
    // has no read primitive).
    expect(home.readdirCalls).toEqual([HOME])
    const markerNames = new Set<string>(CLAUDE_CONFIG_DIR_MARKERS)
    for (const probed of home.probedPaths) {
      const relative = probed.slice(HOME.length + 1)
      const [dirName, ...rest] = relative.split('/')
      expect(['.claude-grok', '.claude.vertex', '.claude-empty', '.claude-file']).toContain(dirName)
      expect(markerNames.has(rest.join('/'))).toBe(true)
    }
    // Privacy: discovery must not log dir listings or entry names.
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('fails open to an empty result when the home dir cannot be listed', () => {
    const consoleSpies = spyOnConsole()
    const fs: LocalClaudeConfigDirFs = {
      readdirNames: () => {
        throw new Error('EACCES')
      },
      pathIsFile: () => {
        throw new Error('should not probe when listing fails')
      }
    }
    expect(discoverLocalClaudeConfigDirNames(HOME, fs)).toEqual([])
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('treats marker probe errors as marker-absent', () => {
    const fs: LocalClaudeConfigDirFs = {
      readdirNames: () => ['.claude-grok'],
      pathIsFile: () => {
        throw new Error('EPERM')
      }
    }
    expect(discoverLocalClaudeConfigDirNames(HOME, fs)).toEqual([])
  })

  it('caps candidate probes so a huge local home cannot block the main process', () => {
    const names = Array.from({ length: 24 }, (_, i) => `.claude-${String(i).padStart(2, '0')}`)
    const home = createFakeHome(
      names,
      names.map((name) => join(HOME, name, 'settings.json'))
    )

    expect(discoverLocalClaudeConfigDirNames(HOME, home.fs)).toEqual(names.slice(0, 16))
    expect(home.probedPaths).toHaveLength(16)
  })
})

describe('discoverRemoteClaudeConfigDirNames', () => {
  function createFakeRemote(
    entries: string[],
    markerPaths: string[]
  ): { sftp: SftpShapedClaudeConfigDirFs; statCalls: string[] } {
    const markers = new Set(markerPaths)
    const statCalls: string[] = []
    return {
      statCalls,
      sftp: {
        readdir: (_path, callback) =>
          callback(
            null,
            entries.map((filename) => ({ filename }))
          ),
        stat: (path, callback) => {
          statCalls.push(path)
          callback(
            markers.has(path) ? null : { code: 2, message: `ENOENT ${path}` },
            markers.has(path) ? { mode: 0o100644 } : undefined
          )
        }
      }
    }
  }

  it('discovers marker-backed dirs under the remote home over SFTP-shaped fs', async () => {
    const remote = createFakeRemote(
      ['.claude', '.claude-grok', '.claudeX', '.claude-empty'],
      ['/home/dev/.claude-grok/settings.json']
    )
    await expect(discoverRemoteClaudeConfigDirNames(remote.sftp, '/home/dev/')).resolves.toEqual([
      '.claude-grok'
    ])
    // Only marker paths inside pattern-matching candidates are ever stat'ed.
    for (const path of remote.statCalls) {
      expect(path).toMatch(/^\/home\/dev\/\.claude[-.][^/]+\/[^/]*\.?[^/]+$/)
      expect(path.startsWith('/home/dev/.claude/')).toBe(false)
    }
  })

  it('fails open when the remote home cannot be listed', async () => {
    const sftp: SftpShapedClaudeConfigDirFs = {
      readdir: (_path, callback) => callback({ code: 3, message: 'permission denied' }),
      stat: () => {
        throw new Error('should not stat when listing fails')
      }
    }
    await expect(discoverRemoteClaudeConfigDirNames(sftp, '/home/dev')).resolves.toEqual([])
  })

  it('caps the candidate probes so a huge remote home cannot delay startup arbitrarily', async () => {
    const names = Array.from({ length: 24 }, (_, i) => `.claude-${String(i).padStart(2, '0')}`)
    const remote = createFakeRemote(
      names,
      names.map((name) => `/home/dev/${name}/settings.json`)
    )
    const discovered = await discoverRemoteClaudeConfigDirNames(remote.sftp, '/home/dev')
    expect(discovered).toEqual(names.slice(0, 16))
    expect(remote.statCalls.length).toBe(16)
  })

  it('stops probing further candidates once the overall discovery deadline passes', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const sftp: SftpShapedClaudeConfigDirFs = {
      readdir: (_path, callback) =>
        callback(
          null,
          ['.claude-a', '.claude-b', '.claude-c'].map((filename) => ({ filename }))
        ),
      stat: (_path, callback) => {
        // Why: each probe burns past the 15s deadline — only the first
        // candidate may complete discovery.
        now += 20_000
        callback(null, { mode: 0o100644 })
      }
    }
    await expect(discoverRemoteClaudeConfigDirNames(sftp, '/home/dev')).resolves.toEqual([
      '.claude-a'
    ])
  })

  it('bounds a marker probe that never calls back by the overall deadline', async () => {
    vi.useFakeTimers()
    const sftp: SftpShapedClaudeConfigDirFs = {
      readdir: (_path, callback) => callback(null, [{ filename: '.claude-grok' }]),
      stat: () => {}
    }

    const discovery = discoverRemoteClaudeConfigDirNames(sftp, '/home/dev')
    await vi.advanceTimersByTimeAsync(15_000)

    await expect(discovery).resolves.toEqual([])
  })

  it('probes markers without following symlinks when lstat is available', async () => {
    const lstatPaths: string[] = []
    const sftp: SftpShapedClaudeConfigDirFs = {
      readdir: (_path, callback) => callback(null, [{ filename: '.claude-grok' }]),
      stat: () => {
        throw new Error('stat must not be used when lstat is present')
      },
      lstat: (path, callback) => {
        lstatPaths.push(path)
        callback(null, { mode: 0o100644 })
      }
    }
    await expect(discoverRemoteClaudeConfigDirNames(sftp, '/home/dev')).resolves.toEqual([
      '.claude-grok'
    ])
    expect(lstatPaths).toEqual(['/home/dev/.claude-grok/settings.json'])
  })
})

describe('deriveClaudeConfigDirLabel', () => {
  it('derives the flavor suffix from posix and windows paths', () => {
    expect(deriveClaudeConfigDirLabel('/home/dev/.claude-grok')).toBe('grok')
    expect(deriveClaudeConfigDirLabel('~/.claude-grok')).toBe('grok')
    expect(deriveClaudeConfigDirLabel('/home/dev/.claude.foo')).toBe('foo')
    expect(deriveClaudeConfigDirLabel('C:\\Users\\dev\\.claude-kimi')).toBe('kimi')
    expect(deriveClaudeConfigDirLabel('/home/dev/.claude-grok/')).toBe('grok')
  })

  it('returns null for the default dir, non-matching names, and empty input', () => {
    expect(deriveClaudeConfigDirLabel('/home/dev/.claude')).toBeNull()
    expect(deriveClaudeConfigDirLabel('/home/dev/.claudeX')).toBeNull()
    expect(deriveClaudeConfigDirLabel('')).toBeNull()
    expect(deriveClaudeConfigDirLabel(undefined)).toBeNull()
    expect(deriveClaudeConfigDirLabel(null)).toBeNull()
    expect(deriveClaudeConfigDirLabel('/home/dev/.claude-')).toBeNull()
  })
})
