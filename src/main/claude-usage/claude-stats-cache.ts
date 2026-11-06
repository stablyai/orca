import { readlink, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type {
  ClaudeStatsCacheHome,
  ClaudeStatsCacheUnavailableReason
} from '../../shared/claude-usage-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { foldWslUncPathCaseInsensitiveParts, parseWslUncPath } from '../../shared/wsl-paths'
import { wslGatedReadFile, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { listRunningWslHomeDirsUnlessStopped } from '../wsl/discovery/wsl-home-unless-stopped'
import {
  claudeProfileConfigHomes,
  getClaudeProfileRouter
} from '../claude-accounts/claude-profile-installed-router'
import { resolveClaudeDefaultHome } from '../claude-accounts/claude-profile-paths'

const STATS_CACHE_FILE = 'stats-cache.json'
const MIN_SUPPORTED_VERSION = 5
// Parsed on the main thread, so cap it.
const MAX_STATS_CACHE_BYTES = 4 * 1024 * 1024
const TORN_READ_RETRY_MS = 150
const MAX_LINK_HOPS = 8

type ParsedStatsCache =
  | { status: 'ok'; totalTokens: number; lastComputedDate: string }
  | { status: 'unavailable'; reason: ClaudeStatsCacheUnavailableReason }

const unavailable = (reason: ClaudeStatsCacheUnavailableReason): ParsedStatsCache => ({
  status: 'unavailable',
  reason
})

const statsCacheVersion = z.object({ version: z.number().int().nonnegative() })
const tokenCount = z.number().nonnegative()
const statsCacheTotals = z.object({
  lastComputedDate: z.iso.date(),
  modelUsage: z.record(
    z.string(),
    z.object({
      inputTokens: tokenCount,
      outputTokens: tokenCount,
      cacheReadInputTokens: tokenCount,
      cacheCreationInputTokens: tokenCount
    })
  )
})

/** The schema is undocumented, so any shape drift reports unavailable rather than a partial or zero total. */
function parseClaudeStatsCache(text: string): ParsedStatsCache {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return unavailable('invalid')
  }
  const versioned = statsCacheVersion.safeParse(data)
  if (!versioned.success) {
    return unavailable('invalid')
  }
  const { version } = versioned.data
  if (version < MIN_SUPPORTED_VERSION) {
    return unavailable('unsupported-version')
  }
  const totals = statsCacheTotals.safeParse(data)
  const totalTokens = totals.success
    ? Object.values(totals.data.modelUsage).reduce(
        (sum, usage) =>
          sum +
          usage.inputTokens +
          usage.outputTokens +
          usage.cacheReadInputTokens +
          usage.cacheCreationInputTokens,
        0
      )
    : Number.NaN
  if (!totals.success || !Number.isFinite(totalTokens)) {
    // Newer versions are accepted while the shape holds; a changed shape is a version problem.
    return unavailable(version > MIN_SUPPORTED_VERSION ? 'unsupported-version' : 'invalid')
  }
  return { status: 'ok', totalTokens, lastComputedDate: totals.data.lastComputedDate }
}

const parsedByPath = new Map<string, { mtimeMs: number; size: number; parsed: ParsedStatsCache }>()

// Gated so a stalled WSL share cannot hang the main thread.
const readStatsCacheText = (path: string) => wslGatedReadFile(path, 'utf8', 'scan')

/** Missing files and unavailable WSL distros resolve to null so those homes are omitted. */
async function readStatsCacheFile(path: string): Promise<ParsedStatsCache | null> {
  try {
    const info = await wslGatedStat(path, 'scan')
    if (!info.isFile()) {
      return null
    }
    const cached = parsedByPath.get(path)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.parsed
    }
    if (info.size > MAX_STATS_CACHE_BYTES) {
      return unavailable('too-large')
    }
    let parsed = parseClaudeStatsCache(await readStatsCacheText(path))
    let settled = parsed.status === 'ok' || parsed.reason !== 'invalid'
    if (!settled) {
      // Claude Code may be rewriting the file in place; one retry rides out a torn read.
      await new Promise((settle) => setTimeout(settle, TORN_READ_RETRY_MS))
      parsed = parseClaudeStatsCache(await readStatsCacheText(path))
      // Still invalid with no write in between means the file itself is malformed.
      const after = await wslGatedStat(path, 'scan')
      settled = after.mtimeMs === info.mtimeMs && after.size === info.size
    }
    if (settled) {
      parsedByPath.set(path, { mtimeMs: info.mtimeMs, size: info.size, parsed })
    }
    return parsed
  } catch (error) {
    return isDefinitiveAbsence(error) || error instanceof WslTranscriptFsError
      ? null
      : unavailable('unreadable')
  }
}

function tildePath(path: string): string {
  const fromHome = relative(homedir(), path)
  return fromHome && !fromHome.startsWith('..') && !isAbsolute(fromHome)
    ? join('~', fromHome)
    : path
}

function configHomeLabel(home: string): string {
  const wsl = parseWslUncPath(home)
  if (wsl) {
    return `${wsl.distro}:${wsl.linuxPath}`
  }
  return getClaudeProfileRouter()?.savedAccountForHome(home)?.email || tildePath(home)
}

// Canonical even when `path`, or the target of a link at it, does not exist yet.
async function canonicalPath(path: string, linkHops = MAX_LINK_HOPS): Promise<string> {
  const real = await realpath(path).catch(() => null)
  if (real !== null) {
    return real
  }
  const target = linkHops > 0 ? await readlink(path).catch(() => null) : null
  if (target !== null) {
    // Relative targets resolve from the link's real directory, as the OS does.
    const linkDir = await canonicalPath(dirname(path), linkHops - 1)
    return canonicalPath(resolve(linkDir, target), linkHops - 1)
  }
  const parent = dirname(path)
  return parent === path ? path : join(await canonicalPath(parent, linkHops), basename(path))
}

// Account homes link `projects` to the default home, so their caches count the same transcripts.
function historyIdentity(home: string): Promise<string> {
  // An ungated realpath on a WSL share can stall; each distro home is its own history.
  const wsl = foldWslUncPathCaseInsensitiveParts(home)
  return wsl ? Promise.resolve(wsl.replace(/\/+$/, '')) : canonicalPath(join(home, 'projects'))
}

async function wslClaudeStatsCacheHomes(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return []
  }
  const homes = await listRunningWslHomeDirsUnlessStopped().catch(() => [])
  // Keep UNC syntax regardless of node:path's platform semantics.
  return homes.map((home) => `${home.replace(/[\\/]+$/, '')}\\.claude`)
}

export async function readHostClaudeStatsCaches(): Promise<ClaudeStatsCacheHome[]> {
  const homes = new Set([
    resolveClaudeDefaultHome(homedir()),
    ...claudeProfileConfigHomes(),
    ...(await wslClaudeStatsCacheHomes())
  ])
  const entries = await Promise.all(
    [...homes].map(async (home) => {
      const parsed = await readStatsCacheFile(join(home, STATS_CACHE_FILE))
      return { home, parsed, identity: parsed ? await historyIdentity(home) : '' }
    })
  )
  // One row per transcript history; lifetime totals only grow, so the largest cache saw the most days.
  const groups = new Map<string, { home: string; parsed: ParsedStatsCache }>()
  for (const { home, identity, parsed } of entries) {
    const current = groups.get(identity)
    if (parsed && (!current || isMoreComplete(parsed, current.parsed))) {
      groups.set(identity, { home, parsed })
    }
  }
  return [...groups.values()].map(({ home, parsed }) => ({
    configHome: home,
    label: configHomeLabel(home),
    ...parsed
  }))
}

function isMoreComplete(candidate: ParsedStatsCache, current: ParsedStatsCache): boolean {
  if (candidate.status !== 'ok') {
    return false
  }
  if (current.status !== 'ok') {
    return true
  }
  return candidate.totalTokens === current.totalTokens
    ? candidate.lastComputedDate > current.lastComputedDate
    : candidate.totalTokens > current.totalTokens
}
