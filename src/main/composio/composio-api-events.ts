// Composio calls only the events setup and its upkeep use, beside ComposioApi's own.
import { z } from 'zod'
import { Account } from './composio-api-answers'
import type { ComposioApi } from './composio-api'

/** Stops the project sending its events anywhere. */
export async function stopComposioEvents(api: ComposioApi, subscriptionId: string): Promise<void> {
  await api.send(`/webhook_subscriptions/${encodeURIComponent(subscriptionId)}`, z.unknown(), {
    method: 'DELETE'
  })
}

/** The Composio user a sign-in belongs to, or null when Composio no longer says. */
export async function composioUserOfAccount(
  api: ComposioApi,
  accountId: string
): Promise<string | null> {
  const account = await api.send(`/connected_accounts/${encodeURIComponent(accountId)}`, Account)
  return account.user_id ?? null
}
