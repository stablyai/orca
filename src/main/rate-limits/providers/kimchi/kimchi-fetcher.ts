import { getMainHttpClient } from '../../../network/http-client'
import { ensureElectronProxyFromEnvironment } from '../../../network/proxy-settings'
import { abortSignalWithTimeout } from '../../../lib/abort-signal-with-timeout'
import type {
  ProviderRateLimits,
  UsageRateLimitFailureKind,
  UsageRateLimitMetadata
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { classifyThrownUsageRequestError } from '../usage-request-failure-kind'
import { parseUsageRetryAfterMs } from '../usage-retry-after'
import { readKimchiUsageAuth, type KimchiUsageAuth } from './kimchi-auth'
import { mapKimchiUserBudget } from './kimchi-usage-mapping'

const API_TIMEOUT_MS = 15_000
const UNAUTHENTICATED_PROVENANCE = 'unauthenticated'

type FetchKimchiOptions = {
  signal?: AbortSignal
  home?: string
}

function metadata(auth: KimchiUsageAuth): UsageRateLimitMetadata {
  return {
    source: 'cli',
    credentialSource: auth.credentialSource,
    authProvenance: auth.authProvenance
  }
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  extra: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider: 'kimchi',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...extra
  }
}

function authFailure(auth: KimchiUsageAuth, response: Response): ProviderRateLimits | null {
  if (response.status === 401) {
    return result('error', 'Kimchi sign-in expired — run `kimchi login` again', {
      usageMetadata: { ...metadata(auth), failureKind: 'stale-token' }
    })
  }
  if (response.status === 403) {
    return result('error', 'This Kimchi API key cannot read monthly budget usage', {
      usageMetadata: { ...metadata(auth), failureKind: 'missing-scope' }
    })
  }
  if (response.status === 429) {
    const now = Date.now()
    const retryAfterMs = parseUsageRetryAfterMs(response.headers.get('retry-after'), now)
    return result('error', 'Kimchi usage is rate limited right now', {
      usageMetadata: {
        ...metadata(auth),
        failureKind: 'rate-limited',
        ...(retryAfterMs !== null ? { retryAtMs: now + retryAfterMs } : {})
      }
    })
  }
  return response.ok
    ? null
    : result('error', `Kimchi usage request failed (HTTP ${response.status})`, {
        usageMetadata: { ...metadata(auth), failureKind: 'server' }
      })
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined
    }
    throw error
  }
}

function failureKind(error: unknown): UsageRateLimitFailureKind {
  return classifyThrownUsageRequestError(error)
}

/** Read only; Kimchi retains ownership of login, key refresh, and budget policy. */
export async function fetchKimchiRateLimits(
  options: FetchKimchiOptions = {}
): Promise<ProviderRateLimits> {
  const authRead = await readKimchiUsageAuth({ home: options.home })
  if (authRead.status !== 'ok') {
    const unsupported = authRead.status === 'unsupported'
    return result(authRead.status === 'error' ? 'error' : 'unavailable', authRead.error, {
      usageMetadata: {
        source: 'cli',
        authProvenance: UNAUTHENTICATED_PROVENANCE,
        failureKind: unsupported ? 'usage-unavailable' : 'missing-credentials'
      }
    })
  }
  const { auth } = authRead

  try {
    await ensureElectronProxyFromEnvironment({ probeUrl: auth.apiBaseUrl }).catch(() => {})
    const headers = { Accept: 'application/json', 'X-API-Key': auth.apiKey }
    const verifyResponse = await getMainHttpClient().fetch(
      `${auth.apiBaseUrl}/ai-optimizer/v1beta/api-keys:verify`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'omit',
        signal: abortSignalWithTimeout(options.signal, API_TIMEOUT_MS)
      }
    )
    const verifyFailure = authFailure(auth, verifyResponse)
    if (verifyFailure) {
      return verifyFailure
    }
    const identity = await responseJson(verifyResponse)
    const organizationId =
      typeof identity === 'object' && identity !== null && 'organizationId' in identity
        ? identity.organizationId
        : undefined
    if (typeof organizationId !== 'string' || !organizationId) {
      return result('error', 'Could not parse Kimchi account identity', {
        usageMetadata: { ...metadata(auth), failureKind: 'parse' }
      })
    }

    const budgetResponse = await getMainHttpClient().fetch(
      `${auth.apiBaseUrl}/ai-optimizer/v1beta/organizations/${encodeURIComponent(organizationId)}/user-budget`,
      {
        headers,
        credentials: 'omit',
        signal: abortSignalWithTimeout(options.signal, API_TIMEOUT_MS)
      }
    )
    const budgetFailure = authFailure(auth, budgetResponse)
    if (budgetFailure) {
      return budgetFailure
    }
    const mapped = mapKimchiUserBudget(await responseJson(budgetResponse))
    if (mapped.kind === 'parse') {
      return result('error', 'Could not parse Kimchi monthly budget usage', {
        usageMetadata: { ...metadata(auth), failureKind: 'parse' }
      })
    }
    if (mapped.kind === 'unavailable') {
      return result('unavailable', 'No capped monthly budget applies to this Kimchi account', {
        usageMetadata: { ...metadata(auth), failureKind: 'usage-unavailable' }
      })
    }

    const latestAuth = await readKimchiUsageAuth({ home: options.home })
    if (latestAuth.status !== 'ok' || latestAuth.auth.authProvenance !== auth.authProvenance) {
      return result('error', 'Kimchi account changed during refresh', {
        usageMetadata: {
          source: 'cli',
          authProvenance:
            latestAuth.status === 'ok'
              ? latestAuth.auth.authProvenance
              : UNAUTHENTICATED_PROVENANCE,
          failureKind: 'missing-credentials'
        }
      })
    }
    return result('ok', null, {
      monthly: mapped.monthly,
      planType: mapped.planType,
      usageMetadata: metadata(auth)
    })
  } catch (error) {
    return result('error', 'Kimchi usage request failed', {
      usageMetadata: { ...metadata(auth), failureKind: failureKind(error) }
    })
  }
}
