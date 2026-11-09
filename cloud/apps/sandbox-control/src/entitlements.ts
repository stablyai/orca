// Billing Worker client (cloud/apps/billing on nwparker/billing-worker): start checks and usage.
// Fails closed: without a configured billing URL no sandbox starts, except the local-dev stub.
import { z } from 'zod'
import type { Env } from './env'

/** What billing sells; anything else is refused there. */
export type MachineSize = 'standard' | 'large'

/** `suspendRunning`: payment grace ran out, so the account's running sandboxes must stop too. */
export type StartDecision = { allow: boolean; reason: string | null; suspendRunning: boolean }

export type UsageSegment = {
  usageId: string
  accountId: string
  sandboxId: string
  machineSize: MachineSize
  startedAt: number
  endedAt: number
}

export type UsageAnswer = { canStartSandbox: boolean; reason: string | null; suspendRunning: boolean }

export type EntitlementClient = {
  checkStart(request: {
    accountId: string
    machineSize: MachineSize
    runningSandboxes: number
  }): Promise<StartDecision>
  reportUsage(segment: UsageSegment): Promise<UsageAnswer>
  /** Accounts whose payment grace expired; polled by the cron. */
  listSuspensions(): Promise<string[]>
}

export class BillingUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BillingUnavailableError'
  }
}

const StartAnswer = z.looseObject({
  allow: z.boolean(),
  reason: z.string().nullable(),
  suspendRunning: z.boolean().default(false)
})
const UsageResponse = z.looseObject({
  canStartSandbox: z.boolean(),
  reason: z.string().nullable(),
  suspendRunning: z.boolean().default(false)
})
const SuspensionsResponse = z.looseObject({
  accounts: z.array(z.looseObject({ accountId: z.string() })).max(10_000)
})

/** Reasons that mean running sandboxes must stop, not just that new starts wait. */
export const STOP_RUNNING_REASONS: ReadonlySet<string> = new Set([
  'included_hours_exhausted',
  'overage_cap_reached',
  'subscription_inactive',
  'no_subscription',
  'payment_grace_expired'
])

/** Dev operator test accounts (`dev:*`, see auth.ts) never reach billing outside prod. */
export function withDevAccountBypass(env: Env, client: EntitlementClient): EntitlementClient {
  if (env.SANDBOX_ENV === 'prod') {
    return client
  }
  return {
    checkStart: (request) =>
      request.accountId.startsWith('dev:')
        ? Promise.resolve({ allow: true, reason: null, suspendRunning: false })
        : client.checkStart(request),
    reportUsage: (segment) =>
      segment.accountId.startsWith('dev:')
        ? Promise.resolve({ canStartSandbox: true, reason: null, suspendRunning: false })
        : client.reportUsage(segment),
    listSuspensions: () => client.listSuspensions()
  }
}

export function createEntitlementClient(
  env: Env,
  doFetch: typeof fetch = env.BILLING ? (input, init) => env.BILLING!.fetch(input, init) : fetch
): EntitlementClient {
  if (env.ENTITLEMENTS_MODE === 'stub') {
    if (env.SANDBOX_ENV === 'prod') {
      throw new BillingUnavailableError('stub entitlements refused in prod')
    }
    return {
      checkStart: async () => ({ allow: true, reason: null, suspendRunning: false }),
      reportUsage: async () => ({ canStartSandbox: true, reason: null, suspendRunning: false }),
      listSuspensions: async () => []
    }
  }
  const base = env.BILLING_URL
  const token = env.CONTROL_PLANE_TOKEN
  async function send<T>(method: 'GET' | 'POST', path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    if (!base || !token) {
      throw new BillingUnavailableError('billing not configured')
    }
    let response: Response
    try {
      response = await doFetch(new URL(path, base), {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
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
    checkStart: (request) => send('POST', '/v1/internal/entitlements/check', request, StartAnswer),
    reportUsage: (segment) => send('POST', '/v1/internal/usage', segment, UsageResponse),
    listSuspensions: async () =>
      (await send('GET', '/v1/internal/suspensions', undefined, SuspensionsResponse)).accounts.map((a) => a.accountId)
  }
}
