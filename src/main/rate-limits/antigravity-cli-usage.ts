import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const execFileAsync = promisify(execFile)

const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080

// Why: `agy` keeps its token in the OS keyring, so the only supported way to read the
// quota is to ask the CLI itself. `/usage` works in print mode and prints one tab
// separated row per family and window.
const USAGE_ARGS = ['-p', '/usage', '--print-timeout', '30s']

const ANTIGRAVITY_CLI_MISSING_REASON =
  'Antigravity usage is not available. The Antigravity CLI (agy) was not found on this machine.'
const ANTIGRAVITY_CLI_UNREADABLE_REASON =
  'Antigravity usage is not available. The Antigravity CLI did not report a quota; sign in with `agy` and try again.'

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function resolveAntigravityBinary(): Promise<string | null> {
  const [lookup, args] = process.platform === 'win32' ? ['where.exe', ['agy']] : ['which', ['agy']]
  try {
    // execFile, not exec: `exec` implies `shell: true`, which silently makes
    // windowsHide a no-op, so the console-subsystem `where` would flash a conhost.
    const { stdout } = await execFileAsync(lookup, args, { encoding: 'utf-8', windowsHide: true })
    const fromPath = stdout.trim().split(/\r?\n/)[0]
    if (fromPath && (await fileExists(fromPath))) {
      return fromPath
    }
  } catch {
    // ignore which/where failure
  }

  // Why: the installer writes the User PATH registry entry, so an Orca process started
  // before the install never sees it. The install prefix is fixed per platform.
  const fallbacks =
    process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe')]
      : [
          path.join(homedir(), '.local', 'bin', 'agy'),
          '/usr/local/bin/agy',
          '/opt/homebrew/bin/agy'
        ]
  for (const candidate of fallbacks) {
    if (candidate && (await fileExists(candidate))) {
      return candidate
    }
  }

  return null
}

type ParsedRow = {
  isGeminiFamily: boolean
  windowMinutes: number
  window: RateLimitWindow
}

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

export function parseAntigravityCliUsage(stdout: string, updatedAt: number): ProviderRateLimits {
  const rows = stdout
    .split(/\r?\n/)
    .map(parseRow)
    .filter((row): row is ParsedRow => row !== null)

  // Why: `agy` prints a Gemini family and a "Claude and GPT models" family. Gemini is the
  // provider's own quota, so it wins; the other family only fills a window Gemini omitted.
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

  return {
    provider: 'antigravity',
    session,
    weekly,
    updatedAt,
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli' }
  }
}

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
