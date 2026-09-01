import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  fetchAntigravityCodeAssist,
  fetchAntigravityModels,
  fetchAntigravityQuotaSummary,
  refreshAntigravityAccessToken
} from './antigravity-api-client'
import {
  hasAntigravityAuthConfigured,
  readAntigravityCredentials,
  type AntigravityCredentialsReadResult
} from './antigravity-credentials'
import { buildAntigravityRateLimitsFromQuota } from './antigravity-quota-aggregation'

export {
  fetchAntigravityCodeAssist,
  fetchAntigravityModels,
  fetchAntigravityQuotaSummary,
  refreshAntigravityAccessToken
} from './antigravity-api-client'

function unavailable(error: string, extras?: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    buckets: [],
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    ...extras
  }
}

function errored(error: string, extras?: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    buckets: [],
    updatedAt: Date.now(),
    error,
    status: 'error',
    ...extras
  }
}

async function syncQuota(
  accessToken: string,
  projectId: string | null,
  signal?: AbortSignal
): Promise<ProviderRateLimits | { unauthorized: true } | { error: string }> {
  const [summaryResult, modelsResult] = await Promise.all([
    fetchAntigravityQuotaSummary(accessToken, projectId, signal),
    fetchAntigravityModels(accessToken, projectId, signal)
  ])
  const summaryError = 'errorStatus' in summaryResult ? summaryResult.errorStatus : null
  const modelsError = 'errorStatus' in modelsResult ? modelsResult.errorStatus : null
  if (summaryError === 401 || modelsError === 401) {
    return { unauthorized: true }
  }
  if (summaryError !== null && modelsError !== null) {
    return { error: `Antigravity quota API failed (HTTP ${summaryError || modelsError})` }
  }
  return buildAntigravityRateLimitsFromQuota({
    summary: 'errorStatus' in summaryResult ? null : summaryResult,
    models: 'errorStatus' in modelsResult ? null : modelsResult
  })
}

export async function fetchAntigravityRateLimits(options?: {
  credentialsReadResult?: AntigravityCredentialsReadResult
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  const signal = options?.signal
  signal?.throwIfAborted()
  const credRead = options?.credentialsReadResult ?? (await readAntigravityCredentials(signal))
  signal?.throwIfAborted()

  if (credRead.status === 'unsupported') {
    return unavailable(
      'Antigravity usage is only available on Windows (Credential Manager gemini:antigravity)'
    )
  }
  if (credRead.status === 'missing') {
    return unavailable('Antigravity login not found — sign in to Antigravity first')
  }
  if (credRead.status === 'error') {
    return errored(credRead.error)
  }

  try {
    let accessToken = credRead.credentials.accessToken
    let { projectId } = await fetchAntigravityCodeAssist(accessToken, signal)
    let result = await syncQuota(accessToken, projectId, signal)

    if ('unauthorized' in result && result.unauthorized) {
      const { refreshToken } = credRead.credentials
      const fresh = refreshToken ? await refreshAntigravityAccessToken(refreshToken, signal) : null
      if (!fresh) {
        return errored('Antigravity token refresh failed — sign in to Antigravity again', {
          usageMetadata: {
            failureKind: 'stale-token',
            credentialSource: 'windows-credential-manager'
          }
        })
      }
      accessToken = fresh
      ;({ projectId } = await fetchAntigravityCodeAssist(accessToken, signal))
      result = await syncQuota(accessToken, projectId, signal)
    }

    if ('unauthorized' in result) {
      return errored('Antigravity quota API unauthorized after refresh', {
        usageMetadata: {
          failureKind: 'stale-token',
          credentialSource: 'windows-credential-manager'
        }
      })
    }

    if ('error' in result && !('status' in result)) {
      return errored(result.error, {
        usageMetadata: {
          failureKind: 'server',
          credentialSource: 'windows-credential-manager'
        }
      })
    }

    return result
  } catch (err) {
    if (signal?.aborted) {
      throw signal.reason
    }
    return errored(err instanceof Error ? err.message : 'Unknown Antigravity usage error', {
      usageMetadata: {
        failureKind: 'network',
        credentialSource: 'windows-credential-manager'
      }
    })
  }
}

export function probeAntigravityAuthConfigured(result: AntigravityCredentialsReadResult): boolean {
  return hasAntigravityAuthConfigured(result)
}
