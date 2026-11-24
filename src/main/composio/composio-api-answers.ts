// Composio's answers as Orca reads them: the shapes it checks, and how each becomes Orca's own type.
import { z } from 'zod'
import type {
  ComposioApp,
  ComposioAppSignIn,
  ComposioConnection,
  ComposioConnectionStatus
} from '../../shared/composio/composio-apps'
import { composioAppLine } from '../../shared/composio/composio-curated-apps'

export const TRIGGER_EVENT = 'composio.trigger.message'
export const EXPIRED_EVENT = 'composio.connected_account.expired'
/** What the project sends Orca: trigger events, and sign-ins that expired so the bot's owner can
 *  reconnect them. */
export const COMPOSIO_EVENTS = [TRIGGER_EVENT, EXPIRED_EVENT]

export type ComposioWebhookSubscription = { id: string; url: string; secret: string | null }

export const Subscription = z.object({
  id: z.string().min(1),
  webhook_url: z.string(),
  secret: z.string().nullish()
})
export const SubscriptionPage = z.object({ items: z.array(Subscription) })
export const RotatedSecret = z.object({ secret: z.string().nullish() })
export const TriggerPage = z.object({ items: z.array(z.unknown()) })
export const TriggerType = z.object({
  name: z.string().min(1),
  toolkit: z.object({ slug: z.string() })
})

export function subscriptionOf(item: z.infer<typeof Subscription>): ComposioWebhookSubscription {
  return { id: item.id, url: item.webhook_url, secret: item.secret ?? null }
}

export const Toolkit = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  no_auth: z.boolean().optional(),
  auth_schemes: z.array(z.string()).optional(),
  // One app's own page names its sign-in kinds here instead of in auth_schemes.
  auth_config_details: z.array(z.object({ mode: z.string() })).nullish(),
  composio_managed_auth_schemes: z.array(z.string()).optional(),
  meta: z
    .object({
      description: z.string().nullish(),
      logo: z.string().nullish(),
      categories: z.array(z.object({ name: z.string().nullish() }).partial()).nullish()
    })
    .partial()
    .optional()
})
export const ToolkitPage = z.object({ items: z.array(Toolkit), next_cursor: z.string().nullish() })

export const Session = z.object({
  session_id: z.string().min(1),
  mcp: z.object({ url: z.string() })
})
export const SessionConfig = z.object({
  config: z.object({ auth_configs: z.record(z.string(), z.string()).nullish() }).nullish()
})
export const AuthConfigPage = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      status: z.string().nullish(),
      toolkit: z.object({ slug: z.string() })
    })
  ),
  next_cursor: z.string().nullish()
})
export const TriggerInstancePage = z.object({
  items: z.array(z.object({ id: z.string().min(1), trigger_name: z.string() })),
  next_cursor: z.string().nullish()
})
export const Link = z.object({
  redirect_url: z.string().url(),
  connected_account_id: z.string().min(1)
})

export const Account = z.object({
  id: z.string().min(1),
  user_id: z.string().nullish(),
  toolkit: z.object({ slug: z.string() }),
  status: z.string(),
  status_reason: z.string().nullish(),
  state: z
    .object({ val: z.object({ displayName: z.string().nullish() }).partial().nullish() })
    .partial()
    .nullish()
})
export const AccountPage = z.object({ items: z.array(Account), next_cursor: z.string().nullish() })

// Sign-in kinds with no OAuth app behind them: Composio's own page asks for the key or password.
export const FORM_SCHEMES = new Set(['API_KEY', 'BEARER_TOKEN', 'BASIC', 'BASIC_WITH_JWT'])

export function appSignIn(toolkit: z.infer<typeof Toolkit>): ComposioAppSignIn {
  // Lists spell a kind in capitals, one app's page in lower case; an empty list says nothing.
  const listed = toolkit.auth_schemes?.length
    ? toolkit.auth_schemes
    : (toolkit.auth_config_details?.map((detail) => detail.mode) ?? [])
  const schemes = listed.map((scheme) => scheme.toUpperCase())
  if (toolkit.no_auth || (schemes.length > 0 && schemes.every((scheme) => scheme === 'NO_AUTH'))) {
    return 'none'
  }
  if (toolkit.composio_managed_auth_schemes?.length) {
    return 'composio'
  }
  return schemes.some((scheme) => FORM_SCHEMES.has(scheme)) ? 'key' : 'own'
}

export function appOf(toolkit: z.infer<typeof Toolkit>): ComposioApp {
  return {
    slug: toolkit.slug,
    name: toolkit.name,
    description: composioAppLine(
      toolkit.slug,
      (toolkit.meta?.categories ?? []).flatMap((category) => category.name ?? []),
      toolkit.meta?.description ?? ''
    ),
    logo: toolkit.meta?.logo ?? null,
    signIn: appSignIn(toolkit)
  }
}

export function statusOf(
  status: string,
  reason: string | null | undefined
): ComposioConnectionStatus {
  // A link nobody finished expires too; it never was a sign-in, so it reads as abandoned.
  if (/before authorization/i.test(reason ?? '')) {
    return 'failed'
  }
  switch (status.toUpperCase()) {
    case 'ACTIVE':
      return 'active'
    case 'INITIALIZING':
    case 'INITIATED':
      return 'pending'
    case 'FAILED':
      return 'failed'
    default:
      return 'expired'
  }
}

export function connectionOf(account: z.infer<typeof Account>): ComposioConnection {
  return {
    id: account.id,
    app: account.toolkit.slug,
    name: account.toolkit.slug,
    status: statusOf(account.status, account.status_reason),
    label: account.state?.val?.displayName?.trim() || null
  }
}
