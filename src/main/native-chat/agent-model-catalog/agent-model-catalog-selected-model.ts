// A chat's selected model, judged against its account's catalog: an aged account-level list that
// lacks it is re-listed once before anything may call it gone, and only a current one names the
// model the host replaces it with.

import {
  agentModelListNames,
  agentModelListReplacement
} from '../../../shared/agent-session-model-fallback'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { StructuredAgentRegistry } from '../agent-session-wire/structured-agent-registry'
import {
  AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
  type AgentModelCatalogEntry,
  type AgentModelCatalogStore
} from './agent-model-catalog-store'

/** The rules a catalog read applies to the chat's selected model, for an agent whose host replaces
 *  a gone selection; inert for any other agent, and with no selection it may replace. */
export function selectedModelRules(input: {
  store: AgentModelCatalogStore
  agents: Pick<StructuredAgentRegistry, 'definition'> | undefined
  agent: string
  fingerprint: string
  selected: string | undefined
}): {
  /** An aged list lacking the selection, with no failure held: re-listed before it decides. */
  needsRelisting: (entry: AgentModelCatalogEntry | null) => boolean
  /** The listed default a gone selection gives way to, named only for a selection, while `listed`
   *  is the current account-level listing itself (not a running chat's, which a project's config
   *  may narrow) and nothing (a listing running, a failure or a held reason) leaves doubt. */
  replacement: (listed: AgentModelCatalogEntry | null, listingInProgress: boolean) => string | null
} {
  const { store, fingerprint, selected } = input
  const applies =
    Boolean(selected) &&
    input.agents?.definition(input.agent)?.restingOptions.replacesUnlistedModel === true
  return {
    needsRelisting: (entry) =>
      applies &&
      entry !== null &&
      !agentModelListNames(entry.models, selected ?? '') &&
      !store.isCurrent(entry) &&
      !store.hasActiveFailure(fingerprint),
    replacement: (listed, listingInProgress) =>
      applies &&
      listed?.origin === 'probe' &&
      !listingInProgress &&
      !store.failure(fingerprint)?.unavailable &&
      !store.hasActiveFailure(fingerprint) &&
      !store.isListing(fingerprint) &&
      store.isCurrent(listed)
        ? agentModelListReplacement(listed.models)
        : null
  }
}

/** Whether the re-listing settled within the wait a read may afford: a start's whole read is
 *  capped by its caller (`agentModelLaunchOptions`), a picker follow-up waits to its deadline, and
 *  any other read waits not at all. Bookkeeping never holds a user action. */
export function relistingSettledInTime(
  relisting: Promise<unknown>,
  read: { forStart?: boolean; waitForListing?: boolean }
): Promise<boolean> {
  if (read.forStart) {
    return relisting.then(
      () => true,
      () => false
    )
  }
  return read.waitForListing
    ? withTimeout(
        relisting.then(() => true),
        AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
        false
      )
    : Promise.resolve(false)
}
