import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { windowsSystem32Binary } from '../../shared/child-process/windows-system-binary'
import type { LocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs
} from '../../shared/wsl-login-shell-command'
import { translateMain } from '../i18n/main-i18n'

const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080

// `agy` keeps its token in the OS keyring, so only the CLI itself can report the quota.
const USAGE_ARGS = ['-p', '/usage', '--print-timeout', '30s']
// Outlives the CLI's own 30s print timeout so the child reports rather than being killed.
const PROCESS_TIMEOUT_MS = 45_000

const cliMissingReason = (): string =>
  translateMain(
    'rateLimits.antigravity.cliMissing',
    'Antigravity usage is not available. The Antigravity CLI (agy) was not found on this machine.'
  )

const quotaUnreadableReason = (): string =>
  translateMain(
    'rateLimits.antigravity.quotaUnreadable',
    'Antigravity usage is not available. The Antigravity CLI did not report a quota; sign in with `agy` and try again.'
  )

function unavailable(
  reason: string,
  failureKind: 'cli-unavailable' | 'usage-unavailable'
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: reason,
    status: 'unavailable',
    usageMetadata: { source: 'cli', failureKind }
  }
}

/** Exists and is executable; X_OK is a no-op on Windows, where the PATH sweep does the work. */
async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Host `agy` path from PATH, then the installer's fixed prefix. Null when none is executable. */
async function resolveHostBinary(signal?: AbortSignal): Promise<string | null> {
  const lookup =
    process.platform === 'win32'
      ? { program: windowsSystem32Binary('where.exe'), args: ['agy'] }
      : { program: '/usr/bin/which', args: ['agy'] }
  try {
    const result = await runProcess({ ...lookup, timeoutMs: 5_000, signal })
    // Every hit, not just the first: a stale entry earlier on PATH would hide a working one.
    for (const candidate of result.stdout.trim().split(/\r?\n/)) {
      if (candidate && (await isExecutable(candidate))) {
        return candidate
      }
    }
  } catch {
    // ignore where/which failure
  }

  // The installer writes the User PATH registry entry, which an already-running Orca never sees.
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

/** One `family <tab> window <tab> remaining% <tab> reset` row, or null when it is not one. */
function parseRow(line: string): ParsedRow | null {
  // Tabs normally, but padded spaces survive some terminals.
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

  // The CLI reports what is left; every other Orca provider reports what is spent.
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
 * Antigravity bills two independent pools with their own resets (#9122), so both survive
 * as named buckets; the headline windows come from the Gemini pool.
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
    return { ...unavailable(quotaUnreadableReason(), 'usage-unavailable'), updatedAt }
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

/** Asks the distro's own `agy`, fenced because the login shell prints its banner to stdout. */
async function fetchFromWsl(distro: string, signal?: AbortSignal): Promise<ProviderRateLimits> {
  // skipWindowsMountDirs so the Windows agy on the mounted PATH cannot answer for the guest.
  const command = [
    buildPosixCommandPathLookupScript(
      { kind: 'literal', value: 'agy' },
      { skipWindowsMountDirs: true }
    ),
    'if [ -z "$resolved" ]; then exit 127; fi',
    `exec "$resolved" ${USAGE_ARGS.join(' ')}`
  ].join('\n')
  const captured = buildWslCapturedLoginShellCommand(command)

  try {
    const result = await runProcess({
      program: windowsSystem32Binary('wsl.exe'),
      args: buildWslExecArgs(distro, ['sh', '-c', captured.command]),
      timeoutMs: PROCESS_TIMEOUT_MS,
      signal
    })
    const payload = captured.readStdout(result.stdout)
    if (result.code !== 0 || payload === null) {
      return unavailable(
        result.code === 127 ? cliMissingReason() : quotaUnreadableReason(),
        result.code === 127 ? 'cli-unavailable' : 'usage-unavailable'
      )
    }
    return parseAntigravityCliUsage(payload, Date.now())
  } catch {
    return unavailable(quotaUnreadableReason(), 'usage-unavailable')
  }
}

/**
 * Reads Antigravity quota from the CLI on the runtime that owns it.
 *
 * `agy` signs in per runtime and keeps the token in that runtime's keyring, so a WSL target
 * must be asked inside WSL — the host copy would answer for a different account (#12370).
 *
 * `RateLimitService` models only host and WSL, so SSH targets cannot be honoured here yet;
 * that needs execution-host awareness across the service (see ssh-execution-boundary.md).
 */
export async function fetchAntigravityRateLimits(options?: {
  target?: LocalAccountRuntimeTarget
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  const { target, signal } = options ?? {}

  if (target?.runtime === 'wsl') {
    return target.wslDistro
      ? await fetchFromWsl(target.wslDistro, signal)
      : unavailable(cliMissingReason(), 'cli-unavailable')
  }

  const binary = await resolveHostBinary(signal)
  if (!binary) {
    return unavailable(cliMissingReason(), 'cli-unavailable')
  }

  try {
    const result = await runProcess({
      program: binary,
      args: USAGE_ARGS,
      timeoutMs: PROCESS_TIMEOUT_MS,
      signal
    })
    // A non-zero exit means signed out or an unreachable backend, not an Orca error.
    return result.code === 0
      ? parseAntigravityCliUsage(result.stdout, Date.now())
      : unavailable(quotaUnreadableReason(), 'usage-unavailable')
  } catch {
    return unavailable(quotaUnreadableReason(), 'usage-unavailable')
  }
}
