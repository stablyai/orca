import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as InstalledRouter from '../claude-accounts/claude-profile-installed-router'
import type * as WslTranscriptFsAccess from '../native-chat/wsl-transcript-fs-access'

type InstalledRouterModule = typeof InstalledRouter
type WslFile = string | Error | (() => string)

const { savedAccountForHome, wslFiles, homes, listRunningWslHomes } = vi.hoisted(() => {
  const homes: { defaultHome: string; config: string[] } = { defaultHome: '', config: [] }
  return {
    savedAccountForHome: vi.fn<(home: string) => { email: string } | undefined>(),
    // Keyed by UNC path.
    wslFiles: new Map<string, WslFile>(),
    homes,
    listRunningWslHomes: vi.fn<() => Promise<string[]>>(async () => [])
  }
})

vi.mock('../native-chat/wsl-transcript-fs-access', async (importOriginal) => {
  const original = await importOriginal<typeof WslTranscriptFsAccess>()
  const wslFile = (path: string): string | undefined => {
    const file = wslFiles.get(path)
    if (file instanceof Error) {
      throw file
    }
    return typeof file === 'function' ? file() : file
  }
  return {
    ...original,
    wslGatedStat: async (path: string, priority: 'scan') =>
      wslFiles.has(path)
        ? { isFile: () => true, size: 1, mtimeMs: 1 }
        : original.wslGatedStat(path, priority),
    wslGatedReadFile: async (path: string, encoding: BufferEncoding, priority: 'scan') =>
      wslFiles.has(path) ? wslFile(path) : original.wslGatedReadFile(path, encoding, priority)
  }
})

vi.mock('../claude-accounts/claude-profile-installed-router', async (importOriginal) => ({
  ...(await importOriginal<InstalledRouterModule>()),
  getClaudeProfileRouter: () => ({ savedAccountForHome }),
  claudeProfileConfigHomes: () => homes.config
}))

vi.mock('../claude-accounts/claude-profile-paths', () => ({
  resolveClaudeDefaultHome: () => homes.defaultHome
}))

vi.mock('../wsl/discovery/wsl-home-unless-stopped', () => ({
  listRunningWslHomeDirsUnlessStopped: listRunningWslHomes
}))

import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { readHostClaudeStatsCaches } from './claude-stats-cache'

function modelUsage(input: number, output: number, cacheRead: number, cacheWrite: number) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    webSearchRequests: 0,
    costUSD: 0
  }
}

function syntheticStatsCache(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 5,
    lastComputedDate: '2026-01-02',
    dailyActivity: [],
    dailyModelTokens: [],
    modelUsage: {
      'model-a': modelUsage(1, 2, 30, 4),
      'model-b': modelUsage(10, 20, 300, 40)
    },
    totalSessions: 3,
    totalMessages: 9,
    firstSessionDate: '2026-01-01T00:00:00.000Z',
    hourCounts: {},
    ...overrides
  }
}

const statsText = (contents: string | Record<string, unknown>) =>
  typeof contents === 'string' ? contents : JSON.stringify(contents)

let root: string
let distroSeq = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-stats-cache-'))
  homes.defaultHome = join(root, '.claude')
  homes.config = []
  savedAccountForHome.mockReturnValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
  wslFiles.clear()
})

function writeHome(name: string, contents: string | Record<string, unknown>): string {
  const home = join(root, name)
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'stats-cache.json'), statsText(contents))
  if (home !== homes.defaultHome) {
    homes.config.push(home)
  }
  return home
}

// Fresh distro per call: the parse cache is keyed by path and survives across tests.
function writeWslHome(file: WslFile): { home: string; label: string } {
  const distro = `Distro${++distroSeq}`
  const home = `\\\\wsl.localhost\\${distro}\\home\\dev\\.claude`
  wslFiles.set(join(home, 'stats-cache.json'), file)
  homes.config.push(home)
  return { home, label: `${distro}:/home/dev/.claude` }
}

async function readAcrossTornReadRetry(): ReturnType<typeof readHostClaudeStatsCaches> {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  const result = readHostClaudeStatsCaches()
  await vi.runAllTimersAsync()
  return result
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  return fn().finally(() =>
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  )
}

describe('readHostClaudeStatsCaches', () => {
  it('sums the four token categories across models', async () => {
    const home = writeHome('.claude', syntheticStatsCache())
    expect(await readHostClaudeStatsCaches()).toEqual([
      {
        configHome: home,
        label: expect.any(String),
        status: 'ok',
        totalTokens: 407,
        lastComputedDate: '2026-01-02'
      }
    ])
  })

  it('accepts a newer version whose shape is unchanged', async () => {
    writeHome('.claude', syntheticStatsCache({ version: 6 }))
    expect(await readHostClaudeStatsCaches()).toMatchObject([{ status: 'ok', totalTokens: 407 }])
  })

  it.each([
    ['an older version', syntheticStatsCache({ version: 4 }), 'unsupported-version'],
    [
      'a newer version with a changed shape',
      syntheticStatsCache({ version: 6, modelUsage: [] }),
      'unsupported-version'
    ],
    [
      'a negative count',
      syntheticStatsCache({ modelUsage: { m: modelUsage(-1, 0, 0, 0) } }),
      'invalid'
    ],
    [
      'counts that overflow to Infinity',
      syntheticStatsCache({ modelUsage: { m: modelUsage(1e308, 1e308, 0, 0) } }),
      'invalid'
    ]
  ])('reports %s as unavailable rather than zero', async (_name, contents, reason) => {
    const { home, label } = writeWslHome(statsText(contents))
    expect(await readAcrossTornReadRetry()).toEqual([
      { configHome: home, label, status: 'unavailable', reason }
    ])
  })

  it('retries a torn read once and reports the rewritten file', async () => {
    const reads = [statsText('{"version":5,"model'), statsText(syntheticStatsCache())]
    const read = vi.fn(() => reads.shift() ?? '')
    writeWslHome(read)
    expect(await readAcrossTornReadRetry()).toMatchObject([{ status: 'ok', totalTokens: 407 }])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('remembers a malformed file that was not rewritten instead of re-reading it', async () => {
    const read = vi.fn(() => statsText('{"version":5,'))
    writeWslHome(read)
    await readAcrossTornReadRetry()
    expect(await readHostClaudeStatsCaches()).toMatchObject([{ reason: 'invalid' }])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('refuses files over the size cap without parsing them', async () => {
    writeHome('.claude', ' '.repeat(4 * 1024 * 1024 + 1))
    expect(await readHostClaudeStatsCaches()).toMatchObject([
      { status: 'unavailable', reason: 'too-large' }
    ])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a file it cannot read as unreadable',
    async () => {
      const home = writeHome('.claude', syntheticStatsCache())
      chmodSync(join(home, 'stats-cache.json'), 0o000)
      expect(await readHostClaudeStatsCaches()).toMatchObject([
        { status: 'unavailable', reason: 'unreadable' }
      ])
    }
  )

  it('omits homes with no stats cache', async () => {
    const empty = join(root, 'empty')
    mkdirSync(empty)
    homes.config.push(empty, join(root, 'absent'))
    expect(await readHostClaudeStatsCaches()).toEqual([])
  })

  it('shows homes sharing one history once, from the cache that saw the most history', async () => {
    const defaultHome = writeHome(
      '.claude',
      syntheticStatsCache({ lastComputedDate: '2026-01-01' })
    )
    mkdirSync(join(defaultHome, 'projects'))
    homes.config.push(`${defaultHome}${sep}`)
    // Newer but smaller: the account home never saw days whose transcripts were deleted earlier.
    const accountHome = writeHome(
      join('userData', 'claude-profiles', 'acct-1', 'home'),
      syntheticStatsCache({
        lastComputedDate: '2026-01-05',
        modelUsage: { 'model-a': modelUsage(1, 2, 3, 4) }
      })
    )
    symlinkSync(join(defaultHome, 'projects'), join(accountHome, 'projects'), 'junction')
    savedAccountForHome.mockImplementation((home) =>
      home === accountHome ? { email: 'a@example.com' } : undefined
    )

    expect(await readHostClaudeStatsCaches()).toEqual([
      {
        configHome: defaultHome,
        label: expect.any(String),
        status: 'ok',
        totalTokens: 407,
        lastComputedDate: '2026-01-01'
      }
    ])
  })

  it('treats a projects link whose target does not exist yet as the same history', async () => {
    const defaultHome = writeHome(
      '.claude',
      syntheticStatsCache({ lastComputedDate: '2026-01-05' })
    )
    const accountHome = writeHome(
      join('userData', 'claude-profiles', 'acct-1', 'home'),
      syntheticStatsCache({ lastComputedDate: '2026-01-01' })
    )
    symlinkSync(join(defaultHome, 'projects'), join(accountHome, 'projects'), 'junction')

    expect(await readHostClaudeStatsCaches()).toMatchObject([
      { configHome: defaultHome, lastComputedDate: '2026-01-05' }
    ])
  })

  it('keeps separate histories apart', async () => {
    const defaultHome = writeHome('.claude', syntheticStatsCache())
    const accountHome = writeHome(
      join('userData', 'claude-profiles', 'acct-1', 'home'),
      syntheticStatsCache({ modelUsage: { m: modelUsage(1, 1, 1, 1) } })
    )

    expect(await readHostClaudeStatsCaches()).toMatchObject([
      { configHome: defaultHome, totalTokens: 407 },
      { configHome: accountHome, totalTokens: 4 }
    ])
  })

  // Relative symlinks need elevated privileges on Windows.
  it.skipIf(process.platform === 'win32')(
    'resolves a relative dangling projects link from the real directory of a linked home',
    async () => {
      const defaultHome = writeHome('.claude', syntheticStatsCache())
      const realHome = join(root, 'data', 'acct')
      mkdirSync(realHome, { recursive: true })
      writeFileSync(
        join(realHome, 'stats-cache.json'),
        statsText(syntheticStatsCache({ modelUsage: { m: modelUsage(1, 1, 1, 1) } }))
      )
      // The OS resolves this to <root>/data/.claude/projects, not the default home's projects.
      symlinkSync(join('..', '.claude', 'projects'), join(realHome, 'projects'))
      const linkedHome = join(root, 'linked-acct')
      symlinkSync(realHome, linkedHome)
      homes.config.push(linkedHome)

      expect(await readHostClaudeStatsCaches()).toMatchObject([
        { configHome: defaultHome, totalTokens: 407 },
        { configHome: linkedHome, totalTokens: 4 }
      ])
    }
  )
})

describe('WSL distro homes', () => {
  const ubuntuHome = String.raw`\\wsl.localhost\Ubuntu\home\dev`
  const debianHome = String.raw`\\wsl.localhost\Debian\home\dev`
  const ubuntu = `${ubuntuHome}\\.claude`
  const debian = `${debianHome}\\.claude`

  beforeEach(() => {
    listRunningWslHomes.mockReset().mockResolvedValue([ubuntuHome, `${debianHome}\\`])
    wslFiles.set(join(ubuntu, 'stats-cache.json'), JSON.stringify(syntheticStatsCache()))
    wslFiles.set(join(debian, 'stats-cache.json'), new WslTranscriptFsError('unavailable', 'gone'))
  })

  it('reads running distros only on Windows', async () => {
    expect(await withPlatform('darwin', readHostClaudeStatsCaches)).toEqual([])
    expect(listRunningWslHomes).not.toHaveBeenCalled()
  })

  it('labels each distro, omits one whose share is unavailable, and folds share aliases', async () => {
    const legacyAlias = String.raw`\\wsl$\ubuntu\home\dev\.claude`
    wslFiles.set(join(legacyAlias, 'stats-cache.json'), JSON.stringify(syntheticStatsCache()))
    homes.config.push(legacyAlias)

    expect(await withPlatform('win32', readHostClaudeStatsCaches)).toEqual([
      {
        configHome: legacyAlias,
        label: 'ubuntu:/home/dev/.claude',
        status: 'ok',
        totalTokens: 407,
        lastComputedDate: '2026-01-02'
      }
    ])
  })
})
