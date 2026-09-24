import path from 'node:path'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  UsageRateLimitFailureKind
} from '../../shared/rate-limit-types'
import { hasReachedAppVersion, parseCliVersion } from '../../shared/app-version'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { runProcess, type ProcessResult } from '../../shared/child-process/run-process'

// Why 1.1.11: older agy answers `--print /usage` with a billable agent turn instead of
// a quota report, so the version is re-checked before every usage invocation.
const AGY_MIN_USAGE_VERSION = '1.1.11'
const WINDOW_MINUTES: Readonly<Record<string, number>> = { '5h': 300, weekly: 10080 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function antigravityFailure(
  status: 'error' | 'unavailable',
  error: string,
  failureKind: UsageRateLimitFailureKind,
  now: number
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    buckets: [],
    updatedAt: now,
    error,
    status,
    usageMetadata: { source: 'cli', failureKind }
  }
}

function quotaFormatError(now: number): ProviderRateLimits {
  return antigravityFailure(
    'error',
    'Antigravity usage returned an unexpected quota format from the agy CLI.',
    'parse',
    now
  )
}

function parseBucket(value: unknown, groupName: string): RateLimitBucket | null {
  if (!isRecord(value)) {
    return null
  }
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const window = typeof value.window === 'string' ? value.window.trim() : ''
  const remaining = value.remaining_fraction
  if (!name || !window || typeof remaining !== 'number' || !(remaining >= 0 && remaining <= 1)) {
    return null
  }
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const resetsAt = typeof value.reset_time === 'string' ? Date.parse(value.reset_time) : Number.NaN
  const windowMinutes = WINDOW_MINUTES[window] ?? 0
  return {
    ...(id ? { id } : {}),
    name,
    groupName,
    windowMinutes,
    ...(windowMinutes === 0 ? { windowLabel: window } : {}),
    usedPercent: (1 - remaining) * 100,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    resetDescription: null
  }
}

/**
 * Maps `agy /usage` quota groups onto buckets, shortest known window first per group.
 * Any malformed entry rejects the whole response so a partial read never hides a pool.
 */
function parseAgyUsageResponse(value: unknown, now: number): ProviderRateLimits {
  const data = isRecord(value) && isRecord(value.command) ? value.command.data : null
  const groups = isRecord(data) ? data.groups : null
  if (!Array.isArray(groups)) {
    return quotaFormatError(now)
  }
  if (groups.length === 0) {
    return antigravityFailure(
      'unavailable',
      'Antigravity usage is not available. The agy CLI returned no quota buckets.',
      'usage-unavailable',
      now
    )
  }
  const buckets: RateLimitBucket[] = []
  for (const group of groups) {
    const groupName = isRecord(group) && typeof group.name === 'string' ? group.name.trim() : ''
    const rawBuckets = isRecord(group) && Array.isArray(group.buckets) ? group.buckets : []
    const parsed = rawBuckets.map((bucket) => parseBucket(bucket, groupName))
    if (!groupName || parsed.length === 0 || parsed.some((bucket) => bucket === null)) {
      return quotaFormatError(now)
    }
    // Why: unknown windows (0 minutes) sort last; `Infinity - Infinity` is NaN, so ties fall to the name.
    const byWindow = (bucket: RateLimitBucket): number => bucket.windowMinutes || Infinity
    buckets.push(
      ...parsed
        .filter((bucket): bucket is RateLimitBucket => bucket !== null)
        .sort((a, b) => byWindow(a) - byWindow(b) || a.name.localeCompare(b.name))
    )
  }
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    buckets,
    updatedAt: now,
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli', lastSuccessfulSource: 'cli' }
  }
}

function runAgy(
  program: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<ProcessResult | null> {
  // Why terminationBarrier: the old execFileCaptureToTermination default killed the whole
  // tree on timeout/abort; without it only the root dies, orphaning agy descendants (Windows
  // cmd.exe behind a .cmd shim, POSIX groups).
  return runProcess({
    program,
    args,
    timeoutMs,
    maxOutputBytes: 1024 * 1024,
    signal,
    terminationBarrier: true
  }).catch(() => null)
}

/** Reads native Antigravity quota via version-gated `agy --print /usage`. */
export async function fetchAntigravityRateLimits(
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  const now = Date.now()
  const agy = resolveCliCommand('agy')
  if (!path.isAbsolute(agy)) {
    return antigravityFailure(
      'unavailable',
      'Antigravity usage is unavailable because the agy CLI was not found.',
      'cli-unavailable',
      now
    )
  }
  const versionRun = await runAgy(agy, ['--version'], 5_000, signal)
  const version = versionRun?.code === 0 ? parseCliVersion(versionRun.stdout) : null
  if (!version || !hasReachedAppVersion(version, AGY_MIN_USAGE_VERSION)) {
    return antigravityFailure(
      'unavailable',
      version
        ? `Antigravity usage needs agy ${AGY_MIN_USAGE_VERSION} or newer (found ${version}). Update the agy CLI to show quota in the status bar.`
        : `Antigravity usage is unavailable because the agy CLI version could not be read. Update agy to ${AGY_MIN_USAGE_VERSION} or newer.`,
      'usage-unavailable',
      now
    )
  }
  const usageRun = await runAgy(
    agy,
    ['--print', '/usage', '--output-format', 'json'],
    10_000,
    signal
  )
  if (usageRun?.code !== 0) {
    return antigravityFailure(
      'error',
      usageRun?.timedOut
        ? 'Antigravity usage could not be refreshed before the agy CLI timed out.'
        : 'Antigravity usage could not be read from the agy CLI.',
      'unknown',
      now
    )
  }
  try {
    return parseAgyUsageResponse(JSON.parse(usageRun.stdout), now)
  } catch {
    return quotaFormatError(now)
  }
}
