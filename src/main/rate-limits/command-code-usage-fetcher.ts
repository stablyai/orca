import type { ProviderRateLimits, UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import { getMainHttpClient } from '../network/http-client'
import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type { CommandCodeHomeResolution } from '../command-code/command-code-runtime-home'
import { getHostCommandCodeHome } from '../command-code/command-code-runtime-home'
import {
  readCommandCodeUsageCredentials,
  type CommandCodeUsageCredentials
} from './command-code-usage-credentials'
import {
  buildCommandCodeEndpoint,
  planTypeFromCommandCodeId,
  projectCommandCodeUsage,
  readRecord,
  readString
} from './command-code-usage-parsing'
import { classifyThrownUsageRequestError } from './usage-request-failure-kind'

// Why: the CLI's own `/usage` overlay reads this group of endpoints with the
// CLI's login; Orca mirrors it instead of inventing its own quota source.
const WHOAMI_ENDPOINT = '/alpha/whoami'
const CREDITS_ENDPOINT = '/alpha/billing/credits'
const SUBSCRIPTIONS_ENDPOINT = '/alpha/billing/subscriptions'
const USAGE_SUMMARY_ENDPOINT = '/alpha/usage/summary'

const API_TIMEOUT_MS = 15_000

type RequestFailureKind = Extract<
  UsageRateLimitFailureKind,
  'stale-token' | 'network' | 'server' | 'parse'
>

type JsonRequestOutcome =
  | { ok: true; data: unknown }
  | { ok: false; error: string; failureKind: RequestFailureKind }

function unavailable(
  error: string,
  failureKind: Extract<
    UsageRateLimitFailureKind,
    'missing-credentials' | 'usage-unavailable'
  > = 'missing-credentials'
): ProviderRateLimits {
  return {
    provider: 'command-code',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: { source: 'cli', failureKind }
  }
}

function failed(
  error: string,
  failureKind: RequestFailureKind,
  authProvenance: string | null
): ProviderRateLimits {
  return {
    provider: 'command-code',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: {
      source: 'cli',
      failureKind,
      ...(authProvenance ? { authProvenance } : {})
    }
  }
}

function redactCredential(error: string, apiKey: string): string {
  return error.replaceAll(apiKey, '[redacted]')
}

async function getJson(
  credentials: CommandCodeUsageCredentials,
  url: string,
  signal: AbortSignal
): Promise<JsonRequestOutcome> {
  let response: Response
  try {
    response = await getMainHttpClient().fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        'Content-Type': 'application/json'
      },
      signal
    })
  } catch (error) {
    return {
      ok: false,
      error: redactCredential(
        error instanceof Error ? error.message : 'Command Code usage request failed',
        credentials.apiKey
      ),
      failureKind: classifyThrownUsageRequestError(error)
    }
  }

  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error: 'Command Code sign-in expired. Run `cmd login` to refresh it.',
        failureKind: 'stale-token'
      }
    }
    return {
      ok: false,
      error: `Command Code usage request failed (${response.status})`,
      failureKind: 'server'
    }
  }

  try {
    return { ok: true, data: await response.json() }
  } catch (error) {
    return {
      ok: false,
      error: 'Could not parse the Command Code usage response',
      failureKind: classifyThrownUsageRequestError(error)
    }
  }
}

/** Failure snapshot for a request outcome, carrying the credential provenance forward. */
function failureFrom(
  outcome: Extract<JsonRequestOutcome, { ok: false }>,
  credentials: CommandCodeUsageCredentials
): ProviderRateLimits {
  return failed(
    redactCredential(outcome.error, credentials.apiKey),
    outcome.failureKind,
    credentials.authProvenance
  )
}

export async function fetchCommandCodeRateLimits(options: {
  home?: CommandCodeHomeResolution
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  const home = options.home ?? {
    runtime: 'host' as const,
    wslDistro: null,
    path: getHostCommandCodeHome()
  }
  if (home.runtime === 'wsl' && !home.path) {
    return unavailable(
      `WSL Command Code home unavailable for ${home.wslDistro ?? 'default distro'}`,
      'usage-unavailable'
    )
  }
  const credentialRead = await readCommandCodeUsageCredentials({ home })
  if (credentialRead.status === 'missing') {
    return unavailable('Command Code is not signed in on this machine')
  }
  if (credentialRead.status === 'error') {
    return failed(credentialRead.error, 'parse', null)
  }
  return fetchUsage(credentialRead.credentials, options.signal)
}

async function fetchUsage(
  credentials: CommandCodeUsageCredentials,
  callerSignal?: AbortSignal
): Promise<ProviderRateLimits> {
  const signal = abortSignalWithTimeout(callerSignal, API_TIMEOUT_MS)

  const whoami = await getJson(
    credentials,
    buildCommandCodeEndpoint(WHOAMI_ENDPOINT, { limits: '1' }),
    signal
  )
  if (!whoami.ok) {
    return failureFrom(whoami, credentials)
  }
  const whoamiPayload = readRecord(whoami.data)
  if (!whoamiPayload) {
    return failed(
      'Could not parse the Command Code account response',
      'parse',
      credentials.authProvenance
    )
  }
  const orgId = readString(readRecord(whoamiPayload.org)?.id)

  const [creditsOutcome, subscriptionOutcome] = await Promise.all([
    getJson(credentials, buildCommandCodeEndpoint(CREDITS_ENDPOINT, { orgId }), signal),
    getJson(credentials, buildCommandCodeEndpoint(SUBSCRIPTIONS_ENDPOINT, { orgId }), signal)
  ])
  if (!creditsOutcome.ok) {
    return failureFrom(creditsOutcome, credentials)
  }
  const creditsPayload = readRecord(creditsOutcome.data)
  if (!creditsPayload) {
    return failed(
      'Could not parse the Command Code credits response',
      'parse',
      credentials.authProvenance
    )
  }

  // Why: the plan and its renewal date are cosmetic here — credits still publish
  // when the subscription endpoint hiccups.
  const subscription = readRecord(
    readRecord(subscriptionOutcome.ok ? subscriptionOutcome.data : null)?.data
  )
  const periodStart = readString(subscription?.currentPeriodStart)
  const periodEnd = readString(subscription?.currentPeriodEnd)

  let summaryPayload: Record<string, unknown> | null = null
  if (periodStart) {
    const summaryOutcome = await getJson(
      credentials,
      buildCommandCodeEndpoint(USAGE_SUMMARY_ENDPOINT, { orgId, since: periodStart }),
      signal
    )
    summaryPayload = summaryOutcome.ok ? readRecord(summaryOutcome.data) : null
  }

  const { session, weekly, monthly, extraUsage } = projectCommandCodeUsage({
    creditsPayload,
    summaryPayload,
    periodEnd
  })

  if (!session && !weekly && !monthly && !extraUsage) {
    return failed(
      'Command Code usage response contained no usable limits',
      'parse',
      credentials.authProvenance
    )
  }

  return {
    provider: 'command-code',
    session,
    weekly,
    monthly,
    extraUsage,
    planType: planTypeFromCommandCodeId(readString(subscription?.planId)),
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'cli',
      credentialSource: credentials.source,
      authProvenance: credentials.authProvenance
    }
  }
}
