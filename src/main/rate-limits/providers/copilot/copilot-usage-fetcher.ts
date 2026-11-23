import { runProcess } from '@orca/process-host'
import type {
  ProviderRateLimits,
  UsageRateLimitFailureKind
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { resolveCommandOnLocalPath } from '../../../ipc/command-path/command-path-resolver'
import { hostShellEnvironment } from '../../../runtime/agent-session/environment/structured-agent-shell-environment'
import { resolveHiddenProbeCwd } from '../../../lib/hidden-probe-cwd'
import { classifyThrownUsageRequestError } from '../usage-request-failure-kind'
import { readCopilotCliUser, type CopilotCliUserRead } from './copilot-cli-user-cache'
import { COPILOT_AIC_BUCKET_NAME } from '../../../../shared/agent-usage/rate-limits/copilot-usage-buckets'
import { mapCopilotUsagePayload, type CopilotUsageMapping } from './copilot-usage-mapping'

const COPILOT_USAGE_ARGS = ['api', '/copilot_internal/user'] as const
const COPILOT_USAGE_TIMEOUT_MS = 10_000
const COPILOT_MAX_OUTPUT_BYTES = 256 * 1024

export type FetchCopilotRateLimitsOptions = {
  signal?: AbortSignal
  runCommand?: typeof runProcess
  resolveCommand?: typeof resolveCommandOnLocalPath
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveCwd?: () => string
  platform?: NodeJS.Platform
  now?: () => number
  readUser?: () => Promise<CopilotCliUserRead | null>
}

function failure(
  status: 'unavailable' | 'error',
  failureKind: UsageRateLimitFailureKind,
  error: string,
  updatedAt: number,
  planType?: string | null
): ProviderRateLimits {
  return {
    provider: 'copilot',
    session: null,
    weekly: null,
    updatedAt,
    error,
    status,
    ...(planType ? { planType } : {}),
    usageMetadata: { source: 'cli', attemptedSources: ['cli'], failureKind }
  }
}

function limitsFromMapping(
  mapped: CopilotUsageMapping | null,
  updatedAt: number
): ProviderRateLimits | null {
  if (!mapped || mapped.buckets.length === 0) {
    return null
  }
  const primary =
    mapped.buckets.find((bucket) => bucket.name === COPILOT_AIC_BUCKET_NAME) ?? mapped.buckets[0]
  return {
    provider: 'copilot',
    session: primary
      ? {
          usedPercent: primary.usedPercent,
          windowMinutes: primary.windowMinutes,
          resetsAt: primary.resetsAt,
          resetDescription: primary.resetDescription
        }
      : null,
    weekly: null,
    buckets: mapped.buckets,
    planType: mapped.planType,
    updatedAt,
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli', attemptedSources: ['cli'] }
  }
}

function looksUnauthenticated(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`
  return /gh auth login|\bHTTP\/?\s*40[13]\b|\bunauthori[sz]ed\b|\bnot logged in\b|\bauthentication\b/i.test(
    text
  )
}

/** Prefer the Copilot CLI account. `gh` is only the fallback and can be a different login. */
export async function fetchCopilotRateLimits(
  options: FetchCopilotRateLimitsOptions = {}
): Promise<ProviderRateLimits> {
  const now = options.now ?? Date.now
  const run = options.runCommand ?? runProcess
  const resolve = options.resolveCommand ?? resolveCommandOnLocalPath
  const resolveEnvironment = options.resolveEnvironment ?? (() => hostShellEnvironment())
  const cancelled = (): ProviderRateLimits =>
    failure('error', 'usage-unavailable', 'Copilot usage refresh was cancelled.', now())

  try {
    if (options.signal?.aborted) {
      return cancelled()
    }
    const cached = await (options.readUser ?? readCopilotCliUser)()
    const cachedLimits = cached
      ? limitsFromMapping(mapCopilotUsagePayload(cached.payload), now())
      : null
    if (cachedLimits) {
      return cachedLimits
    }
    const env = await resolveEnvironment()
    const program = await resolve('gh', {
      platform: options.platform ?? process.platform,
      env
    })
    if (options.signal?.aborted) {
      return cancelled()
    }
    if (!program) {
      return failure(
        'unavailable',
        'cli-unavailable',
        'Copilot usage is unavailable. GitHub CLI (`gh`) was not found on this machine.',
        now()
      )
    }
    const result = await run({
      program,
      args: COPILOT_USAGE_ARGS,
      env,
      cwd: (options.resolveCwd ?? resolveHiddenProbeCwd)(),
      timeoutMs: COPILOT_USAGE_TIMEOUT_MS,
      maxOutputBytes: COPILOT_MAX_OUTPUT_BYTES,
      signal: options.signal
    })
    if (options.signal?.aborted) {
      return cancelled()
    }
    if (result.timedOut || result.signal !== null) {
      return failure('error', 'network', 'Copilot usage request timed out', now())
    }
    if (result.code !== 0) {
      return looksUnauthenticated(result.stderr, result.stdout)
        ? failure(
            'unavailable',
            'missing-credentials',
            'Not signed in to GitHub — run `gh auth login`',
            now()
          )
        : failure('error', 'server', 'Copilot usage request failed', now())
    }
    let payload: unknown
    try {
      payload = JSON.parse(result.stdout)
    } catch (error) {
      return failure(
        'error',
        classifyThrownUsageRequestError(error),
        'Copilot usage response could not be parsed',
        now()
      )
    }
    const mapped = limitsFromMapping(mapCopilotUsagePayload(payload), now())
    if (mapped) {
      return mapped
    }
    return failure(
      'unavailable',
      'usage-unavailable',
      'Copilot reported no usage allowance for this account',
      now()
    )
  } catch (error) {
    return failure(
      'error',
      classifyThrownUsageRequestError(error),
      'Copilot usage request failed',
      now()
    )
  }
}
