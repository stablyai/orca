import { isAbsolute } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  resolveAntigravityCommand,
  withCliRuntimeOnPath
} from '../../shared/node-cli-command-resolution'
import { buildAntigravityRateLimits, parseAntigravityQuotaRows } from './antigravity-quota-parser'
import { resolveHiddenRateLimitPtyCwd } from './hidden-rate-limit-pty-cwd'

const QUOTA_TIMEOUT_MS = 20_000
const MAX_QUOTA_OUTPUT_BYTES = 256 * 1024
const MAX_DIAGNOSTIC_LENGTH = 300

// Why: `--print` runs one prompt non-interactively and exits, and slash commands still
// expand there — so `/quota` is read without driving the TUI or scraping its screen.
const ANTIGRAVITY_QUOTA_ARGS = ['--print', '/quota']

function antigravityResult(status: 'error' | 'unavailable', error: string): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status
  }
}

function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .find((candidate) => candidate.trim().length > 0)
      ?.trim() ?? ''
  return line.length > MAX_DIAGNOSTIC_LENGTH ? line.slice(0, MAX_DIAGNOSTIC_LENGTH) : line
}

export async function fetchAntigravityRateLimits(options?: {
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return antigravityResult('error', 'Antigravity quota request aborted')
  }
  const command = resolveAntigravityCommand()
  // Why: the resolver falls back to the bare name when nothing on PATH or in the known
  // install dirs matches, so skip the doomed spawn every cycle.
  if (!isAbsolute(command)) {
    return antigravityResult('unavailable', 'Antigravity CLI not found')
  }
  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess({
      program: command,
      args: ANTIGRAVITY_QUOTA_ARGS,
      cwd: resolveHiddenRateLimitPtyCwd(),
      env: withCliRuntimeOnPath(command, { ...process.env }),
      timeoutMs: QUOTA_TIMEOUT_MS,
      maxOutputBytes: MAX_QUOTA_OUTPUT_BYTES,
      signal: options?.signal
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Why: runProcess only rejects when the child could not start, so a missing binary lands here.
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? antigravityResult('unavailable', 'Antigravity CLI not found')
      : antigravityResult('error', message)
  }
  if (options?.signal?.aborted) {
    return antigravityResult('error', 'Antigravity quota request aborted')
  }
  if (result.timedOut) {
    return antigravityResult('error', 'Antigravity quota request timed out')
  }
  if (result.code !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout)
    return antigravityResult(
      'error',
      detail ? `Antigravity quota request failed: ${detail}` : 'Antigravity quota request failed'
    )
  }
  const rows = parseAntigravityQuotaRows(result.stdout)
  if (rows.length === 0) {
    return antigravityResult('error', 'Antigravity returned no quota data')
  }
  return buildAntigravityRateLimits(rows)
}
