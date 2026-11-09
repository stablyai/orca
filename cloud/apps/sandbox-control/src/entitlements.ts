// Billing Worker client (cloud/apps/billing on nwparker/billing-worker): start checks and usage.
// Fails closed: without a configured billing URL no sandbox starts, except the local-dev stub.
import { z } from 'zod'
import type { Env } from './env'

export type MachineSize = 'standard' | 'large' | 'xlarge'

export type StartDecision = { allow: boolean; reason: string | null }

export type UsageSegment = {
  usageId: string
  accountId: string
  sandboxId: string
  machineSize: MachineSize
  startedAt: number
  endedAt: number
}

export type UsageAnswer = { canStartSandbox: boolean; reason: string | null }

export type EntitlementClient = {
  checkStart(request: {
    accountId: string
    machineSize: MachineSize
    runningSandboxes: number
  }): Promise<StartDecision>
  reportUsage(segment: UsageSegment): Promise<UsageAnswer>
}

export class BillingUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BillingUnavailableError'
  }
}

const StartAnswer = z.looseObject({ allow: z.boolean(), reason: z.string().nullable() })
const UsageResponse = z.looseObject({ canStartSandbox: z.boolean(), reason: z.string().nullable() })

/** Reasons that mean running sandboxes must stop, not just that new starts wait. */
export const STOP_RUNNING_REASONS: ReadonlySet<string> = new Set([
  'included_hours_exhausted',
  'overage_cap_reached',
  'subscription_inactive',
  'no_subscription'
])

export function createEntitlementClient(env: Env, doFetch: typeof fetch = fetch): EntitlementClient {
  if (env.ENTITLEMENTS_MODE === 'stub') {
    if (env.SANDBOX_ENV === 'prod') {
      throw new BillingUnavailableError('stub entitlements refused in prod')
    }
    return {
      checkStart: async () => ({ allow: true, reason: null }),
      reportUsage: async () => ({ canStartSandbox: true, reason: null })
    }
  }
  const base = env.BILLING_URL
  const token = env.CONTROL_PLANE_TOKEN
  async function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    if (!base || !token) {
      throw new BillingUnavailableError('billing not configured')
    }
    let response: Response
    try {
      response = await doFetch(new URL(path, base), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000)
      })
    } catch {
      throw new BillingUnavailableError('billing unreachable')
    }
    if (!response.ok) {
      throw new BillingUnavailableError(`billing answered ${response.status}`)
    }
    const parsed = schema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      throw new BillingUnavailableError('billing answered an unexpected body')
    }
    return parsed.data
  }
  return {
    checkStart: (request) => post('/v1/internal/entitlements/check', request, StartAnswer),
    reportUsage: (segment) => post('/v1/internal/usage', segment, UsageResponse)
  }
}
