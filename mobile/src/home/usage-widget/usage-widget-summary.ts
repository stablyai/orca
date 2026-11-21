import * as z from 'zod'
import type { UsagePercentageDisplay } from '../../../../src/shared/agent-usage/display/usage-percentage-display'
import type { AccountsSnapshot, RateLimitWindow } from '../../accounts/accounts-snapshot'
import {
  getActiveProviderRateLimits,
  hasRenderableUsage,
  type ProviderKey
} from '../../accounts/usage/usage-selectors'

// The iOS widget decodes this shape (targets/usage-widget/UsageWidgetSummary.swift); bump `v` on a breaking change.
const UsageWidgetWindowSchema = z.object({
  usedPercent: z.number(),
  resetsAt: z.number().nullable()
})

const UsageWidgetSummarySchema = z.object({
  v: z.literal(1),
  display: z.enum(['used', 'remaining']),
  hosts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      providers: z.array(
        z.object({
          provider: z.enum(['claude', 'codex']),
          updatedAt: z.number(),
          session: UsageWidgetWindowSchema.nullable(),
          weekly: UsageWidgetWindowSchema.nullable()
        })
      )
    })
  )
})

export type UsageWidgetSummary = z.infer<typeof UsageWidgetSummarySchema>
type UsageWidgetHost = UsageWidgetSummary['hosts'][number]
type UsageWidgetProvider = UsageWidgetHost['providers'][number]
type UsageWidgetWindow = z.infer<typeof UsageWidgetWindowSchema>

const PROVIDERS: readonly ProviderKey[] = ['claude', 'codex']

function widgetWindow(window: RateLimitWindow | null): UsageWidgetWindow | null {
  return window ? { usedPercent: window.usedPercent, resetsAt: window.resetsAt } : null
}

// The active login's windows only: no emails, org names, or other accounts leave the app.
function widgetProviders(snapshot: AccountsSnapshot): UsageWidgetProvider[] {
  return PROVIDERS.flatMap((provider) => {
    const limits = getActiveProviderRateLimits(snapshot, provider)
    if (!limits || !hasRenderableUsage(snapshot, provider) || limits.updatedAt <= 0) {
      return []
    }
    const session = widgetWindow(limits.session)
    const weekly = widgetWindow(limits.weekly)
    return session || weekly ? [{ provider, updatedAt: limits.updatedAt, session, weekly }] : []
  })
}

/** Live snapshots replace a desktop's entry; a desktop that is offline keeps its last one until it is unpaired. */
export function buildUsageWidgetSummary(input: {
  hosts: readonly { id: string; name: string }[]
  liveSnapshots: Readonly<Record<string, AccountsSnapshot>>
  previous: UsageWidgetSummary | null
  display: UsagePercentageDisplay
}): UsageWidgetSummary {
  const previousById = new Map(input.previous?.hosts.map((host) => [host.id, host]))
  const hosts = input.hosts.flatMap((host): UsageWidgetHost[] => {
    const snapshot = input.liveSnapshots[host.id]
    const providers = snapshot ? widgetProviders(snapshot) : previousById.get(host.id)?.providers
    return providers && providers.length > 0 ? [{ id: host.id, name: host.name, providers }] : []
  })
  return { v: 1, display: input.display, hosts }
}

export function parseUsageWidgetSummary(raw: string | null): UsageWidgetSummary | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = UsageWidgetSummarySchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
