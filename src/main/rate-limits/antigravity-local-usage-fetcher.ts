import http from 'node:http'
import https from 'node:https'
import type {
  ProviderRateLimits,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import {
  discoverAntigravityEndpoints,
  type AntigravityEndpoint
} from './antigravity-local-endpoint-discovery'

let cachedEndpoint: AntigravityEndpoint | null = null

const CONNECT_RPC_TIMEOUT_MS = 2500

type QuotaResponsePayload = {
  response?: {
    groups?: {
      displayName?: string
      buckets?: {
        bucketId?: string
        displayName?: string
        window?: string
        remainingFraction?: number
        resetTime?: string
        disabled?: boolean
      }[]
    }[]
  }
}

type UserStatusPayload = {
  userStatus?: {
    name?: string
    email?: string
    userTier?: { name?: string }
    planStatus?: {
      planInfo?: {
        planName?: string
        planDisplayName?: string
      }
    }
  }
}

async function requestRpcJson<T>(
  port: number,
  isHttps: boolean,
  path: string,
  csrfToken?: string
): Promise<{ ok: boolean; status?: number; data?: T; error?: string }> {
  return new Promise((resolve) => {
    const mod = isHttps ? https : http
    const body = JSON.stringify({
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
        ideVersion: 'unknown',
        locale: 'en'
      }
    })

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'Content-Length': Buffer.byteLength(body)
    }
    if (csrfToken) {
      headers['X-Codeium-Csrf-Token'] = csrfToken
    }

    const req = mod.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        headers,
        timeout: CONNECT_RPC_TIMEOUT_MS
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve({ ok: true, status: res.statusCode, data: JSON.parse(data) as T })
            } catch {
              resolve({ ok: false, status: res.statusCode, error: 'invalid json' })
            }
          } else {
            resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` })
          }
        })
      }
    )

    req.on('error', (err) => resolve({ ok: false, error: err.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: 'timeout' })
    })
    req.write(body)
    req.end()
  })
}

async function probeEndpoint(ep: AntigravityEndpoint): Promise<ProviderRateLimits | null> {
  const quotaRes = await requestRpcJson<QuotaResponsePayload>(
    ep.port,
    ep.isHttps,
    '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
    ep.csrfToken
  )
  if (!quotaRes.ok || !quotaRes.data?.response?.groups) {
    return null
  }

  const statusRes = await requestRpcJson<UserStatusPayload>(
    ep.port,
    ep.isHttps,
    '/exa.language_server_pb.LanguageServerService/GetUserStatus',
    ep.csrfToken
  )
  const userStatus = statusRes.ok ? statusRes.data?.userStatus : null
  const planName =
    userStatus?.planStatus?.planInfo?.planName ||
    userStatus?.planStatus?.planInfo?.planDisplayName ||
    userStatus?.userTier?.name ||
    null

  const groups = quotaRes.data.response.groups ?? []
  let gemini5h: RateLimitWindow | null = null
  let geminiWeekly: RateLimitWindow | null = null
  let thirdParty5h: RateLimitWindow | null = null
  let thirdPartyWeekly: RateLimitWindow | null = null

  for (const group of groups) {
    const dispName = (group.displayName || '').toLowerCase()
    const isGeminiGroup = dispName.includes('gemini')
    const isThirdParty = dispName.includes('claude') || dispName.includes('gpt')

    for (const bucket of group.buckets || []) {
      if (bucket.disabled) {
        continue
      }
      const bucketId = (bucket.bucketId || '').toLowerCase()
      const window = (bucket.window || '').toLowerCase()
      const isWeekly = window === 'weekly' || bucketId.endsWith('-weekly')
      const is5h = window === '5h' || bucketId.endsWith('-5h')
      const remainingFraction =
        typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : 1
      const usedPercent = Math.min(100, Math.max(0, Math.round((1 - remainingFraction) * 100)))
      const resetsAt = bucket.resetTime ? new Date(bucket.resetTime).getTime() : null
      const validResetsAt = Number.isFinite(resetsAt) ? resetsAt : null

      const windowObj: RateLimitWindow = {
        usedPercent,
        windowMinutes: isWeekly ? 10080 : is5h ? 300 : 60,
        resetsAt: validResetsAt,
        resetDescription: null
      }

      if (isGeminiGroup) {
        if (is5h && (!gemini5h || usedPercent > gemini5h.usedPercent)) {
          gemini5h = windowObj
        } else if (isWeekly && (!geminiWeekly || usedPercent > geminiWeekly.usedPercent)) {
          geminiWeekly = windowObj
        }
      } else if (isThirdParty) {
        if (is5h && (!thirdParty5h || usedPercent > thirdParty5h.usedPercent)) {
          thirdParty5h = windowObj
        } else if (isWeekly && (!thirdPartyWeekly || usedPercent > thirdPartyWeekly.usedPercent)) {
          thirdPartyWeekly = windowObj
        }
      }
    }
  }

  // Dynamic selection:
  // If Claude/GPT models in Antigravity are actively used or more constrained, track them;
  // otherwise track the primary Gemini models.
  const isThirdPartyActive =
    (thirdParty5h !== null && thirdParty5h.usedPercent > (gemini5h?.usedPercent ?? 0)) ||
    (thirdPartyWeekly !== null && thirdPartyWeekly.usedPercent > (geminiWeekly?.usedPercent ?? 0))

  const sessionWindow = isThirdPartyActive
    ? (thirdParty5h ?? gemini5h)
    : (gemini5h ?? thirdParty5h)

  const weeklyWindow = isThirdPartyActive
    ? (thirdPartyWeekly ?? geminiWeekly)
    : (geminiWeekly ?? thirdPartyWeekly)

  return {
    provider: 'gemini',
    session: sessionWindow,
    weekly: weeklyWindow,
    planType: planName,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'live-session' }
  }
}

export async function fetchAntigravityLocalRateLimits(): Promise<ProviderRateLimits | null> {
  if (cachedEndpoint) {
    const res = await probeEndpoint(cachedEndpoint)
    if (res) {
      return res
    }
    cachedEndpoint = null
  }

  const candidates = await discoverAntigravityEndpoints()
  for (const ep of candidates) {
    const res = await probeEndpoint(ep)
    if (res) {
      cachedEndpoint = ep
      return res
    }
  }

  return null
}

export function resetCachedAntigravityEndpointForTests(): void {
  cachedEndpoint = null
}
