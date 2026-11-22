import * as z from 'zod'
import type {
  AccountsSnapshot,
  ProviderRateLimits,
  RateLimitWindow
} from '../../accounts/accounts-snapshot'
import {
  getActiveProviderRateLimits,
  getOtherUsageProviders
} from '../../accounts/usage/usage-selectors'
import { selectHomeUsageSections } from '../tabs/home-usage-cards'

const UsageWidgetWindowSchema = z.object({
  usedPercent: z.number(),
  resetsAt: z.number().nullable()
})

const UsageWidgetSummarySchema = z.object({
  hosts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      providers: z.array(
        z.object({
          provider: z.string().min(1),
          updatedAt: z.number(),
          session: UsageWidgetWindowSchema.nullable(),
          weekly: UsageWidgetWindowSchema.nullable()
        })
      )
    })
  )
})

/** What the widget may know about each desktop: no emails, org names or other logins leave the app. */
export type UsageWidgetSummary = z.infer<typeof UsageWidgetSummarySchema>
type UsageWidgetHost = UsageWidgetSummary['hosts'][number]
type UsageWidgetProvider = UsageWidgetHost['providers'][number]

function widgetWindow(
  window: RateLimitWindow | null
): z.infer<typeof UsageWidgetWindowSchema> | null {
  return window ? { usedPercent: window.usedPercent, resetsAt: window.resetsAt } : null
}

// The widget only draws the 5-hour and weekly windows, so a provider with neither is left out.
function widgetProvider(limits: ProviderRateLimits | null): UsageWidgetProvider[] {
  const session = widgetWindow(limits?.session ?? null)
  const weekly = widgetWindow(limits?.weekly ?? null)
  if (!limits || limits.updatedAt <= 0 || (!session && !weekly)) {
    return []
  }
  return [{ provider: limits.provider, updatedAt: limits.updatedAt, session, weekly }]
}

// The active login per provider, in the Usage tab's order.
function widgetProviders(snapshot: AccountsSnapshot): UsageWidgetProvider[] {
  const accountProviders = selectHomeUsageSections(snapshot).map((section) =>
    getActiveProviderRateLimits(snapshot, section.provider)
  )
  return [...accountProviders, ...getOtherUsageProviders(snapshot)].flatMap(widgetProvider)
}

/** Live snapshots replace a desktop's entry; an offline desktop keeps its last one until it is unpaired. */
export function buildUsageWidgetSummary(input: {
  hosts: readonly { id: string; name: string }[]
  liveSnapshots: Readonly<Record<string, AccountsSnapshot>>
  previous: UsageWidgetSummary | null
}): UsageWidgetSummary {
  const previousById = new Map(input.previous?.hosts.map((host) => [host.id, host]))
  const hosts = input.hosts.flatMap((host): UsageWidgetHost[] => {
    const snapshot = input.liveSnapshots[host.id]
    const providers = snapshot ? widgetProviders(snapshot) : previousById.get(host.id)?.providers
    return providers && providers.length > 0 ? [{ id: host.id, name: host.name, providers }] : []
  })
  return { hosts }
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
