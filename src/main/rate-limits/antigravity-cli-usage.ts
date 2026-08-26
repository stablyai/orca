import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../shared/rate-limit-types'

const execFileAsync = promisify(execFile)

const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080

// Why: `agy` keeps its token in the OS keyring, so reading files the way the Gemini
// fetcher does can never describe Antigravity. `/usage` works in print mode and prints
// one tab separated row per model family and window, which is the supported way in.
const USAGE_ARGS = ['-p', '/usage', '--print-timeout', '30s']

const ANTIGRAVITY_CLI_MISSING_REASON =
  'Antigravity usage is not available. The Antigravity CLI (agy) was not found on this machine.'
const ANTIGRAVITY_CLI_UNREADABLE_REASON =
  'Antigravity usage is not available. The Antigravity CLI did not report a quota; sign in with `agy` and try again.'

/** Resolves only when the path exists and is executable. */
async function isExecutable(filePath: string): Promise<boolean> {
  try {
    // Why: X_OK, not a bare existence check. A leftover file from an older install
    // still "exists" and would shadow a working `agy` found later in the list.
    await access(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Finds the `agy` executable, preferring PATH and falling back to the installer's
 * fixed prefix. Returns null when no executable candidate is found.
 */
async function resolveAntigravityBinary(): Promise<string | null> {
  const [lookup, args] = process.platform === 'win32' ? ['where.exe', ['agy']] : ['which', ['agy']]
  try {
    // execFile, not exec: `exec` implies `shell: true`, which silently makes
    // windowsHide a no-op, so the console-subsystem `where` would flash a conhost.
    const { stdout } = await execFileAsync(lookup, args, { encoding: 'utf-8', windowsHide: true })
    for (const candidate of stdout.trim().split(/\r?\n/)) {
      if (candidate && (await isExecutable(candidate))) {
        return candidate
      }
    }
  } catch {
    // ignore which/where failure
  }

  // Why: the installer writes the Windows User PATH registry entry, so an Orca process
  // started before the install never sees it. The install prefix is fixed per platform.
  const fallbacks =
    process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe')]
      : [
          path.join(homedir(), '.local', 'bin', 'agy'),
          '/usr/local/bin/agy',
          '/opt/homebrew/bin/agy'
        ]
  for (const candidate of fallbacks) {
    if (candidate && (await isExecutable(candidate))) {
      return candidate
    }
  }

  return null
}

type ParsedRow = {
  family: string
  isGeminiFamily: boolean
  windowMinutes: number
  window: RateLimitWindow
}

/** Parses one `family <tab> window <tab> remaining% <tab> reset` row, or null if it is not one. */
function parseRow(line: string): ParsedRow | null {
  // The CLI separates columns with tabs, but padded spaces survive some terminals.
  const columns = line
    .split(/\t|\s{2,}/)
    .map((column) => column.trim())
    .filter(Boolean)
  if (columns.length < 3) {
    return null
  }

  const [family, label, percent, resetAt] = columns
  const remaining = /^(\d+(?:\.\d+)?)%$/.exec(percent)?.[1]
  if (remaining === undefined) {
    return null
  }

  const windowMinutes = /five\s*hour/i.test(label)
    ? SESSION_WINDOW_MINUTES
    : /week/i.test(label)
      ? WEEKLY_WINDOW_MINUTES
      : null
  if (windowMinutes === null) {
    return null
  }

  // Why: the CLI reports what is left; every other Orca provider reports what is spent.
  const usedPercent = Math.min(100, Math.max(0, 100 - Number(remaining)))
  const parsedReset = resetAt ? Date.parse(resetAt) : Number.NaN

  return {
    family,
    isGeminiFamily: /gemini/i.test(family),
    windowMinutes,
    window: {
      usedPercent,
      windowMinutes,
      resetsAt: Number.isNaN(parsedReset) ? null : parsedReset,
      resetDescription: null
    }
  }
}

/**
 * Converts `agy -p "/usage"` output into provider rate limits.
 *
 * Antigravity plans bill two independent pools ("Gemini Models" and "Claude and GPT
 * models") with their own reset times, so both are exposed as named buckets. The
 * headline session and weekly windows come from the Gemini pool, which is the
 * provider's own quota.
 */
export function parseAntigravityCliUsage(stdout: string, updatedAt: number): ProviderRateLimits {
  const rows = stdout
    .split(/\r?\n/)
    .map(parseRow)
    .filter((row): row is ParsedRow => row !== null)

  const pick = (windowMinutes: number): RateLimitWindow | null => {
    const candidates = rows.filter((row) => row.windowMinutes === windowMinutes)
    const preferred = candidates.find((row) => row.isGeminiFamily) ?? candidates[0]
    return preferred?.window ?? null
  }

  const session = pick(SESSION_WINDOW_MINUTES)
  const weekly = pick(WEEKLY_WINDOW_MINUTES)

  if (!session && !weekly) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt,
      error: ANTIGRAVITY_CLI_UNREADABLE_REASON,
      status: 'unavailable',
      usageMetadata: { source: 'cli', failureKind: 'usage-unavailable' }
    }
  }

  const buckets: RateLimitBucket[] = rows.map((row) => ({
    ...row.window,
    name: `${row.family} · ${row.windowMinutes === SESSION_WINDOW_MINUTES ? '5h' : '7d'}`
  }))

  return {
    provider: 'antigravity',
    session,
    weekly,
    buckets,
    updatedAt,
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli' }
  }
}

/**
 * Reads Antigravity quota by running the local Antigravity CLI.
 *
 * Scope note: this describes the machine Orca's main process runs on, which is the same
 * scope the Gemini read it replaces already had — `fetchGeminiRateLimits` reads local
 * credentials with no runtime target either. Per-runtime targeting for both providers is
 * a separate change.
 */
export async function fetchAntigravityRateLimits(
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  const binary = await resolveAntigravityBinary()
  if (!binary) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: ANTIGRAVITY_CLI_MISSING_REASON,
      status: 'unavailable',
      usageMetadata: { source: 'cli', failureKind: 'cli-unavailable' }
    }
  }

  try {
    const { stdout } = await execFileAsync(binary, USAGE_ARGS, {
      encoding: 'utf-8',
      windowsHide: true,
      signal
    })
    return parseAntigravityCliUsage(stdout, Date.now())
  } catch {
    // Why: a non-zero exit means signed out or an unreachable backend. Neither is an Orca
    // error the user can act on from the meter, so it reads as unavailable, not failed.
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: ANTIGRAVITY_CLI_UNREADABLE_REASON,
      status: 'unavailable',
      usageMetadata: { source: 'cli', failureKind: 'usage-unavailable' }
    }
  }
}
