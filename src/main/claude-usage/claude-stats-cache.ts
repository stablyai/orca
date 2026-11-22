import { readFile, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type {
  ClaudeStatsCacheHome,
  ClaudeStatsCacheHomeRef,
  ClaudeStatsCacheUnavailableReason
} from '../../shared/agent-usage/analytics/claude-usage-types'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'

const STATS_CACHE_FILE = 'stats-cache.json'
const MIN_SUPPORTED_VERSION = 5
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

/** Missing files resolve to null so those homes are omitted. */
async function readStatsCacheFile(path: string): Promise<ParsedStatsCache | null> {
  try {
    const info = await stat(path)
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
    let parsed = parseClaudeStatsCache(await readFile(path, 'utf8'))
    let settled = parsed.status === 'ok' || parsed.reason !== 'invalid'
    if (!settled) {
      // Claude Code may be rewriting the file in place; one retry rides out a torn read.
      await new Promise((settle) => setTimeout(settle, TORN_READ_RETRY_MS))
      parsed = parseClaudeStatsCache(await readFile(path, 'utf8'))
      // Still invalid with no write in between means the file itself is malformed.
      const after = await stat(path)
      settled = after.mtimeMs === info.mtimeMs && after.size === info.size
    }
    if (settled) {
      parsedByPath.set(path, { mtimeMs: info.mtimeMs, size: info.size, parsed })
    }
    return parsed
  } catch (error) {
    return isDefinitiveAbsence(error) ? null : unavailable('unreadable')
  }
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

export async function readClaudeStatsCaches(
  homes: readonly ClaudeStatsCacheHomeRef[]
): Promise<ClaudeStatsCacheHome[]> {
  const entries = await Promise.all(
    homes.map(async (ref) => {
      const parsed = await readStatsCacheFile(join(ref.home, STATS_CACHE_FILE))
      // Account homes link `projects` to the default home, so their caches count the same transcripts.
      return {
        ref,
        parsed,
        identity: parsed ? await canonicalPath(join(ref.home, 'projects')) : ''
      }
    })
  )
  // Lifetime totals only grow, so the largest cache of a shared history saw the most days.
  const groups = new Map<string, { ref: ClaudeStatsCacheHomeRef; parsed: ParsedStatsCache }>()
  for (const { ref, identity, parsed } of entries) {
    const current = groups.get(identity)
    if (parsed && (!current || isMoreComplete(parsed, current.parsed))) {
      groups.set(identity, { ref, parsed })
    }
  }
  return [...groups.values()].map(({ ref, parsed }) => ({
    configHome: ref.home,
    label: ref.label,
    ...parsed
  }))
}
