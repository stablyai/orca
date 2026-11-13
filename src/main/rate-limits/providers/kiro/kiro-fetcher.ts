import { stripAnsiEscapeSequences } from '../../../../shared/ansi-escape-sequences'
import type {
  ProviderRateLimits,
  UsageRateLimitMetadata
} from '../../../../shared/rate-limit-types'
import { runProcess } from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

const MONTHLY_WINDOW_MINUTES = 43_200
const KIRO_USAGE_TIMEOUT_MS = 15_000
const KIRO_USAGE_MAX_OUTPUT_BYTES = 256 * 1024
const KIRO_USAGE_ARGS = ['chat', '--no-interactive', '/usage'] as const
const KIRO_CLI_PROGRAM = 'kiro-cli'
const FIXED_ERROR_MESSAGE = 'Unable to read Kiro usage'
const MAX_PLAN_LABEL_LENGTH = 64

export type KiroUsageProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>

export type ParsedKiroUsage =
  | {
      kind: 'ok'
      used: number
      limit: number
      unit: 'credits'
      usedPercent: number
      planType: string | null
      resetsAt: number | null
      resetDescription: string | null
    }
  | { kind: 'unauthenticated' }
  | { kind: 'error' }

function parseNumber(raw: string): number | null {
  if (!/^\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^\d+(?:\.\d+)?$/.test(raw)) {
    return null
  }
  const value = Number(raw.replace(/,/g, ''))
  return Number.isFinite(value) ? value : null
}

function looksUnauthenticated(text: string): boolean {
  return /not\s+logged\s+in|not\s+signed\s+in|please\s+log\s+in|run\s+kiro-cli\s+to\s+sign\s+in/i.test(
    text
  )
}

function parsePlanLabel(header: string): string | null {
  const segments = header.split('|').map((segment) => segment.trim())
  const last = segments.at(-1)
  if (!last || /resets on/i.test(last) || /estimated usage/i.test(last)) {
    return null
  }
  const trimmed = last.slice(0, MAX_PLAN_LABEL_LENGTH).trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseResetDate(text: string): {
  resetsAt: number | null
  resetDescription: string | null
} {
  const match = text.match(/resets on\s+(\d{4})-(\d{2})-(\d{2})/i)
  if (!match) {
    return { resetsAt: null, resetDescription: null }
  }
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  const resetsAt = Number.isNaN(date.getTime()) ? null : date.getTime()
  return { resetsAt, resetDescription: `${year}-${month}-${day}` }
}

export function parseKiroUsageOutput(output: string): ParsedKiroUsage {
  const text = stripAnsiEscapeSequences(output)
  const creditMatch = text.match(
    /Credits\s*\(\s*([\d.,]+)\s+of\s+([\d.,]+)\s+covered in plan\s*\)/i
  )
  if (!creditMatch) {
    return looksUnauthenticated(text) ? { kind: 'unauthenticated' } : { kind: 'error' }
  }
  const used = parseNumber(creditMatch[1])
  const limit = parseNumber(creditMatch[2])
  if (used === null || limit === null || limit <= 0) {
    return { kind: 'error' }
  }
  const usedPercent = Math.min(100, Math.max(0, (used / limit) * 100))
  const { resetsAt, resetDescription } = parseResetDate(text)
  const headerLine = text.split('\n').find((line) => /estimated usage/i.test(line)) ?? ''
  return {
    kind: 'ok',
    used,
    limit,
    unit: 'credits',
    usedPercent,
    planType: parsePlanLabel(headerLine),
    resetsAt,
    resetDescription
  }
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'kiro',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

function buildUsageEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    TERM: 'dumb',
    LANG: 'C',
    LC_ALL: 'C'
  }
}

function isEnoent(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) {
    return false
  }
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
}

export async function fetchKiroRateLimits(options?: {
  signal?: AbortSignal
  processRunner?: KiroUsageProcessRunner
}): Promise<ProviderRateLimits> {
  const runner = options?.processRunner ?? runProcess
  let probe: ProcessResult
  try {
    probe = await runner({
      program: KIRO_CLI_PROGRAM,
      args: [...KIRO_USAGE_ARGS],
      env: buildUsageEnv(),
      timeoutMs: KIRO_USAGE_TIMEOUT_MS,
      maxOutputBytes: KIRO_USAGE_MAX_OUTPUT_BYTES,
      terminationBarrier: true,
      signal: options?.signal
    })
  } catch (error) {
    if (isEnoent(error)) {
      return result('unavailable', 'Kiro CLI not found', { failureKind: 'cli-unavailable' })
    }
    return result('error', FIXED_ERROR_MESSAGE)
  }

  if (probe.timedOut || probe.outputTruncated) {
    return result('error', FIXED_ERROR_MESSAGE)
  }
  const output = [probe.stdout, probe.stderr].filter(Boolean).join('\n')
  if (looksUnauthenticated(stripAnsiEscapeSequences(output))) {
    return result('unavailable', 'Not signed in to Kiro', { failureKind: 'missing-credentials' })
  }
  if (probe.code !== 0) {
    return result('error', FIXED_ERROR_MESSAGE)
  }
  const parsed = parseKiroUsageOutput(output)
  if (parsed.kind === 'unauthenticated') {
    return result('unavailable', 'Not signed in to Kiro', { failureKind: 'missing-credentials' })
  }
  if (parsed.kind === 'error') {
    return result('error', FIXED_ERROR_MESSAGE, { failureKind: 'usage-unavailable' })
  }

  return {
    provider: 'kiro',
    session: null,
    weekly: null,
    monthly: {
      usedPercent: parsed.usedPercent,
      windowMinutes: MONTHLY_WINDOW_MINUTES,
      resetsAt: parsed.resetsAt,
      resetDescription: parsed.resetDescription
    },
    usageAmount: { used: parsed.used, limit: parsed.limit, unit: parsed.unit },
    planType: parsed.planType,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli' }
  }
}
