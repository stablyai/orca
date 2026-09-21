import path from 'node:path'
import type { ProviderRateLimits, RateLimitBucket } from '../../shared/rate-limit-types'
import { hasReachedAppVersion } from '../../shared/app-version'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { execFileCaptureToTermination } from '../git/command-runner/exec-file-capture'

const AGY_USAGE_ARGS = ['--print', '/usage', '--output-format', 'json']
const AGY_USAGE_TIMEOUT_MS = 10_000
const AGY_USAGE_MAX_BUFFER = 1024 * 1024
const AGY_VERSION_ARGS = ['--version']
const AGY_VERSION_TIMEOUT_MS = 5_000
const AGY_VERSION_MAX_BUFFER = 64 * 1024
// Why 1.1.11: older agy answers `-p /usage` with a billable agent turn instead of
// a quota report; 1.1.11 handles read-only slash commands in print mode directly.
const AGY_MIN_USAGE_VERSION = '1.1.11'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function emptyAntigravityResult(
  status: 'error' | 'unavailable',
  error: string,
  now: number,
  failureKind: 'cli-unavailable' | 'usage-unavailable' | 'parse' | 'unknown'
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

function parseWindowMinutes(window: unknown): number {
  if (window === '5h') {
    return 300
  }
  if (window === 'weekly') {
    return 10080
  }
  return 0
}

function createAgyTimeoutError(): Error {
  return Object.assign(new Error('The agy CLI timed out.'), { code: 'ETIMEDOUT' })
}

function parseResetAt(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function agyQuotaFormatError(now: number): ProviderRateLimits {
  return emptyAntigravityResult(
    'error',
    'Antigravity usage returned an unexpected quota format from the agy CLI.',
    now,
    'parse'
  )
}

/**
 * Maps the `agy -p /usage` quota groups onto rate-limit buckets. Well-formed but
 * unknown groups/windows are preserved; any malformed entry rejects the whole
 * response so a partial read can never hide the tightest quota pool as `ok`.
 */
function parseAgyUsageResponse(value: unknown, now = Date.now()): ProviderRateLimits {
  const root = isRecord(value) ? value : {}
  const command = isRecord(root.command) ? root.command : {}
  const data = isRecord(command.data) ? command.data : {}
  const groups = data.groups
  if (!Array.isArray(groups) || groups.length === 0) {
    return emptyAntigravityResult(
      'unavailable',
      'Antigravity usage is not available. The agy CLI returned no quota buckets.',
      now,
      'usage-unavailable'
    )
  }
  const buckets: RateLimitBucket[] = []
  for (const groupValue of groups) {
    if (!isRecord(groupValue)) {
      return agyQuotaFormatError(now)
    }
    const groupName = typeof groupValue.name === 'string' ? groupValue.name.trim() : ''
    if (!groupName || !Array.isArray(groupValue.buckets) || groupValue.buckets.length === 0) {
      return agyQuotaFormatError(now)
    }
    const groupDescription =
      typeof groupValue.description === 'string' ? groupValue.description.trim() || null : null
    for (const bucketValue of groupValue.buckets) {
      if (!isRecord(bucketValue)) {
        return agyQuotaFormatError(now)
      }
      const name = typeof bucketValue.name === 'string' ? bucketValue.name.trim() : ''
      const remaining = bucketValue.remaining_fraction
      const sourceWindow = typeof bucketValue.window === 'string' ? bucketValue.window.trim() : ''
      if (
        !name ||
        !sourceWindow ||
        typeof remaining !== 'number' ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 1
      ) {
        return agyQuotaFormatError(now)
      }
      buckets.push({
        ...(typeof bucketValue.id === 'string' && bucketValue.id.trim()
          ? { id: bucketValue.id.trim() }
          : {}),
        name,
        groupName,
        groupDescription,
        windowMinutes: parseWindowMinutes(sourceWindow),
        windowLabel: sourceWindow,
        usedPercent: (1 - remaining) * 100,
        resetsAt: parseResetAt(bucketValue.reset_time),
        resetDescription: null
      })
    }
  }
  if (buckets.length === 0) {
    return emptyAntigravityResult(
      'unavailable',
      'Antigravity usage is not available. The agy CLI returned no quota buckets.',
      now,
      'usage-unavailable'
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

function classifyAgyFailure(error: unknown): {
  message: string
  status: 'error' | 'unavailable'
  failureKind: 'cli-unavailable' | 'usage-unavailable' | 'parse' | 'unknown'
} {
  const record = isRecord(error) ? error : {}
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : ''
  if (record.code === 'ENOENT') {
    return {
      message: 'Antigravity usage is unavailable because the agy CLI was not found.',
      status: 'unavailable',
      failureKind: 'cli-unavailable'
    }
  }
  if (
    record.code === 'ETIMEDOUT' ||
    record.code === 'ERR_CHILD_PROCESS_TIMEOUT' ||
    record.killed === true ||
    record.signal === 'SIGTERM'
  ) {
    return {
      message: 'Antigravity usage could not be refreshed before the agy CLI timed out.',
      status: 'error',
      failureKind: 'unknown'
    }
  }
  if (/auth|login|sign.?in|credential/i.test(stderr)) {
    return {
      message: 'Antigravity usage is unavailable because the agy CLI is not authenticated.',
      status: 'unavailable',
      failureKind: 'usage-unavailable'
    }
  }
  return {
    message: 'Antigravity usage could not be read from the agy CLI.',
    status: 'error',
    failureKind: 'unknown'
  }
}

/** Resolves the `agy` executable off PATH (bare name when absent). */
export function getAntigravityUsageCommand(): string {
  return resolveCliCommand('agy')
}

// Why a pre-check: invoking /usage on agy <1.1.11 starts an agent turn that spends
// quota on every refresh, so the version gate must run before any usage invocation.
// Unreadable versions fail closed for the same reason.
/** Extracts the first semver triple (preserving prerelease/build) from `agy --version` output. */
export function extractAgyVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?)/)
  return match ? match[1] : null
}

/** Probes `agy --version`; aborts propagate, every other failure reads as unsupported. */
async function checkAgyUsageSupport(
  command: string,
  signal?: AbortSignal
): Promise<{ supported: boolean; version: string | null }> {
  try {
    const { stdout } = await execFileCaptureToTermination(command, AGY_VERSION_ARGS, {
      encoding: 'utf8',
      timeout: AGY_VERSION_TIMEOUT_MS,
      maxBuffer: AGY_VERSION_MAX_BUFFER,
      signal,
      createTimeoutError: createAgyTimeoutError
    })
    const version = extractAgyVersion(String(stdout))
    return {
      supported: version !== null && hasReachedAppVersion(version, AGY_MIN_USAGE_VERSION),
      version
    }
  } catch (error) {
    if (signal?.aborted || (isRecord(error) && error.name === 'AbortError')) {
      throw error
    }
    return { supported: false, version: null }
  }
}

/** Reads native Antigravity quota: version-gated `agy -p /usage`, else an actionable `unavailable`. */
export async function fetchAntigravityRateLimits(
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  const now = Date.now()
  const command = getAntigravityUsageCommand()
  if (!path.isAbsolute(command)) {
    return emptyAntigravityResult(
      'unavailable',
      'Antigravity usage is unavailable because the agy CLI was not found.',
      now,
      'cli-unavailable'
    )
  }
  const versionCheck = await checkAgyUsageSupport(command, signal)
  if (!versionCheck.supported) {
    return emptyAntigravityResult(
      'unavailable',
      versionCheck.version
        ? `Antigravity usage needs agy ${AGY_MIN_USAGE_VERSION} or newer (found ${versionCheck.version}). Update the agy CLI to show quota in the status bar.`
        : 'Antigravity usage is unavailable because the agy CLI version could not be read. Update agy to 1.1.11 or newer.',
      now,
      'usage-unavailable'
    )
  }
  try {
    const { stdout } = await execFileCaptureToTermination(command, AGY_USAGE_ARGS, {
      encoding: 'utf8',
      timeout: AGY_USAGE_TIMEOUT_MS,
      maxBuffer: AGY_USAGE_MAX_BUFFER,
      signal,
      createTimeoutError: createAgyTimeoutError
    })
    try {
      return parseAgyUsageResponse(JSON.parse(String(stdout)), now)
    } catch {
      return agyQuotaFormatError(now)
    }
  } catch (error) {
    if (signal?.aborted || (isRecord(error) && error.name === 'AbortError')) {
      throw error
    }
    const failure = classifyAgyFailure(error)
    return emptyAntigravityResult(failure.status, failure.message, now, failure.failureKind)
  }
}

export { AGY_MIN_USAGE_VERSION, AGY_USAGE_ARGS, AGY_VERSION_ARGS, parseAgyUsageResponse }
