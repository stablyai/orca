import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const OPENCODE_SERVER_URL = 'https://opencode.ai/_server'
const API_TIMEOUT_MS = 10_000

// Why: OpenCode Go returns usage as serialized JS objects (text/javascript)
// rather than JSON. We regex-extract values because the format is stable
// and avoids eval() of untrusted server output.

function extractWorkspaceId(body: string): string | null {
  const match = body.match(/wrk_[A-Za-z0-9]+/)
  return match ? match[0] : null
}

function extractUsageBlock(body: string, blockName: string): string | null {
  const pattern = new RegExp(`${blockName}\\s*:\\s*\\{([^}]*)\\}`)
  const match = body.match(pattern)
  return match ? match[1] : null
}

function parseUsagePercent(block: string): number | null {
  const match = block.match(/usagePercent\s*:\s*(-?\d+\.?\d*)/)
  if (!match) {
    return null
  }
  const val = parseFloat(match[1])
  return isNaN(val) ? null : val
}

function parseResetInSec(block: string): number | null {
  const match = block.match(/resetInSec\s*:\s*(\d+)/)
  if (!match) {
    return null
  }
  const val = parseInt(match[1], 10)
  return isNaN(val) ? null : val
}

function buildWindow(block: string | null, windowMinutes: number): RateLimitWindow | null {
  if (!block) {
    return null
  }
  const usedPercent = parseUsagePercent(block)
  const resetInSec = parseResetInSec(block)
  if (usedPercent === null) {
    return null
  }
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt: resetInSec !== null ? Date.now() + resetInSec * 1000 : null,
    resetDescription: null
  }
}

async function postToServer(body: unknown, cookie: string): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  try {
    return await net.fetch(OPENCODE_SERVER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchOpenCodeGoRateLimits(cookie: string): Promise<ProviderRateLimits> {
  if (!cookie) {
    return {
      provider: 'opencode-go',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: null,
      status: 'unavailable'
    }
  }

  try {
    // Step 1: fetch workspace ID
    const workspaceRes = await postToServer({ path: 'workspaces', args: [] }, cookie)
    if (!workspaceRes.ok) {
      return {
        provider: 'opencode-go',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: `Workspace fetch failed (${workspaceRes.status})`,
        status: 'error'
      }
    }

    const workspaceBody = await workspaceRes.text()
    const workspaceId = extractWorkspaceId(workspaceBody)
    if (!workspaceId) {
      return {
        provider: 'opencode-go',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Workspace ID not found in response',
        status: 'error'
      }
    }

    // Step 2: fetch subscription usage
    const subRes = await postToServer({ path: 'subscription.get', args: [{ workspaceId }] }, cookie)
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

    const subBody = await subRes.text()
    const rollingBlock = extractUsageBlock(subBody, 'rollingUsage')
    const weeklyBlock = extractUsageBlock(subBody, 'weeklyUsage')

    const session = buildWindow(rollingBlock, 300)
    const weekly = buildWindow(weeklyBlock, 10080)

    if (!session) {
      return {
        provider: 'opencode-go',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Failed to parse usage data from response',
        status: 'error'
      }
    }

    return {
      provider: 'opencode-go',
      session,
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
  }
}
