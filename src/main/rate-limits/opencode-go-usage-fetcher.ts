import { net } from 'electron'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

const OPENCODE_SERVER_URL = 'https://opencode.ai/_server'
const API_TIMEOUT_MS = 10_000

function parseUsageFromJs(text: string): {
  primaryUsed: number
  primaryLimit: number
  secondaryUsed: number
  secondaryLimit: number
} | null {
  // Extract the first two "used":<num> and "limit":<num> pairs from the
  // text/javascript payload. Primary (rolling) is the first pair; secondary
  // (weekly) is the second pair.
  const usedMatches = [...text.matchAll(/"used":\s*(\d+)/g)]
  const limitMatches = [...text.matchAll(/"limit":\s*(\d+)/g)]

  if (usedMatches.length === 0 || limitMatches.length === 0) {
    return null
  }

  const primaryUsed = parseInt(usedMatches[0][1], 10)
  const primaryLimit = parseInt(limitMatches[0][1], 10)

  const secondaryUsed = usedMatches.length > 1 ? parseInt(usedMatches[1][1], 10) : 0
  const secondaryLimit = limitMatches.length > 1 ? parseInt(limitMatches[1][1], 10) : 0

  return { primaryUsed, primaryLimit, secondaryUsed, secondaryLimit }
}

export async function fetchOpenCodeGoRateLimits(cookie: string): Promise<ProviderRateLimits> {
  if (!cookie.trim()) {
    return {
      provider: 'opencode-go',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: null,
      status: 'unavailable'
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  try {
    // Step 1: workspaces — validates the session cookie
    const workspacesRes = await net.fetch(OPENCODE_SERVER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ method: 'workspaces' }),
      signal: controller.signal
    })

    if (!workspacesRes.ok) {
      return {
        provider: 'opencode-go',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: `Workspaces fetch failed (${workspacesRes.status})`,
        status: 'error'
      }
    }

    // Step 2: subscription.get — fetches usage data as text/javascript
    const subRes = await net.fetch(OPENCODE_SERVER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify({ method: 'subscription.get' }),
      signal: controller.signal
    })

    if (!subRes.ok) {
      return {
        provider: 'opencode-go',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: `Subscription fetch failed (${subRes.status})`,
        status: 'error'
      }
    }

    const subText = await subRes.text()
    const parsed = parseUsageFromJs(subText)

    if (!parsed || parsed.primaryLimit === 0) {
      return {
        provider: 'opencode-go',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Invalid usage data',
        status: 'error'
      }
    }

    const sessionUsedPercent = Math.min(
      100,
      Math.max(0, Math.round((parsed.primaryUsed / parsed.primaryLimit) * 100))
    )

    const weekly =
      parsed.secondaryLimit > 0
        ? {
            usedPercent: Math.min(
              100,
              Math.max(0, Math.round((parsed.secondaryUsed / parsed.secondaryLimit) * 100))
            ),
            windowMinutes: 10080,
            resetsAt: null,
            resetDescription: null
          }
        : null

    return {
      provider: 'opencode-go',
      session: {
        usedPercent: sessionUsedPercent,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      weekly,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      provider: 'opencode-go',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: message,
      status: 'error'
    }
  } finally {
    clearTimeout(timeout)
  }
}
