import path from 'node:path'
import type { ProviderRateLimits, RateLimitBucket } from '../../shared/rate-limit-types'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { execFileCaptureToTermination } from '../git/command-runner/exec-file-capture'

const AGY_USAGE_ARGS = ['--print', '/usage', '--output-format', 'json']
const AGY_USAGE_TIMEOUT_MS = 10_000
const AGY_USAGE_MAX_BUFFER = 1024 * 1024

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

function parseAgyUsageResponse(value: unknown, now = Date.now()): ProviderRateLimits {
  const root = isRecord(value) ? value : {}
  const command = isRecord(root.command) ? root.command : {}
  const data = isRecord(command.data) ? command.data : {}
  const groups = data.groups
  const buckets: RateLimitBucket[] = []
  if (Array.isArray(groups)) {
    for (const groupValue of groups) {
      if (!groupValue || typeof groupValue !== 'object') {
        continue
      }
      const group = groupValue
      const groupName = typeof group.name === 'string' ? group.name.trim() : ''
      if (!groupName || !Array.isArray(group.buckets)) {
        continue
      }
      const groupDescription =
        typeof group.description === 'string' ? group.description.trim() || null : null
      for (const bucketValue of group.buckets) {
        if (!bucketValue || typeof bucketValue !== 'object') {
          continue
        }
        const bucket = bucketValue
        const name = typeof bucket.name === 'string' ? bucket.name.trim() : ''
        const remaining = bucket.remaining_fraction
        if (
          !name ||
          typeof remaining !== 'number' ||
          !Number.isFinite(remaining) ||
          remaining < 0 ||
          remaining > 1
        ) {
          continue
        }
        const sourceWindow = typeof bucket.window === 'string' ? bucket.window.trim() : ''
        buckets.push({
          ...(typeof bucket.id === 'string' && bucket.id.trim() ? { id: bucket.id.trim() } : {}),
          name,
          groupName,
          groupDescription,
          windowMinutes: parseWindowMinutes(sourceWindow),
          ...(sourceWindow ? { windowLabel: sourceWindow } : {}),
          usedPercent: (1 - remaining) * 100,
          resetsAt: parseResetAt(bucket.reset_time),
          resetDescription: null
        })
      }
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

export function getAntigravityUsageCommand(): string {
  return resolveCliCommand('agy')
}

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
      return emptyAntigravityResult(
        'error',
        'Antigravity usage returned malformed JSON from the agy CLI.',
        now,
        'parse'
      )
    }
  } catch (error) {
    if (signal?.aborted || (isRecord(error) && error.name === 'AbortError')) {
      throw error
    }
    const failure = classifyAgyFailure(error)
    return emptyAntigravityResult(failure.status, failure.message, now, failure.failureKind)
  }
}

export { AGY_USAGE_ARGS, parseAgyUsageResponse }
