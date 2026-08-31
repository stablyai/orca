import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import type { BrowserClientPageExecutionHostGrant } from './browser-host-client-page-creation'
import type { BrowserHostLeaseState } from './browser-host-lease-records'
import type { RuntimeBrowserPlacement } from './browser-host-page-placement'
import type { BrowserHostRuntimePageIntent } from './browser-host-page-reconciliation-plan'

/**
 * An inventory entry a restarted runtime may take back over. `workspaceId` is narrowed to present
 * because the runtime record it rebuilds cannot exist without one.
 */
export type AdoptableClientHostedPage = BrowserClientHostedPageInventory &
  Readonly<{ workspaceId: string }>

export type ClientHostedPageAdoptionCandidacy = {
  inventory: readonly BrowserClientHostedPageInventory[]
  browserHostClientId: string
  /** This process's id. An entry already naming it was placed by us, not by a predecessor. */
  authorityRuntimeId: string
  hasRuntimePage: (browserPageId: string) => boolean
}

/**
 * Picks the inventory entries a freshly started runtime may reclaim.
 *
 * Each guard fails closed on its own: a dead guest cannot be rekeyed, a workspace-less entry cannot
 * become a record, another host's page is not ours to take, an entry naming this process is one we
 * closed deliberately rather than lost to a restart, and a page we already track needs recovery
 * rather than adoption.
 */
export function selectAdoptableClientHostedPages(
  input: ClientHostedPageAdoptionCandidacy
): readonly AdoptableClientHostedPage[] {
  return input.inventory.filter((page): page is AdoptableClientHostedPage => {
    if (page.state !== 'active') {
      return false
    }
    if (page.workspaceId === undefined) {
      return false
    }
    if (page.browserHostClientId !== input.browserHostClientId) {
      return false
    }
    if (page.authorityRuntimeId === input.authorityRuntimeId) {
      return false
    }
    return !input.hasRuntimePage(page.browserPageId)
  })
}

export type ClientHostedPageAdoptionAuthority = {
  authorityRuntimeId: string
  authorityEpoch: string
}

export type ClientHostedPageAdoptionLease = {
  browserHostClientId: string
  browserHostGeneration: number
}

/**
 * Turns adoptable entries into restore intents under this runtime's authority.
 *
 * Deliberately no `reclaimFrom`: reclaim rekeys a live guest onto a new authority, but it requires
 * the execution-host key to be unchanged, and no kind of key survives a restart
 * (`browserNetworkExecutionHostKey`). `native`/`wsl` keys name the runtime that minted them; an SSH
 * key names the target instead, but carries the provider epoch, which is freshly random per process.
 * The plan must therefore close the orphaned guest and restore the tab at its last URL. The tab
 * survives; the DOM behind it cannot.
 *
 * Generations are handed out above every generation the inventory reports, because the placement
 * registry refuses a generation below one it has already issued.
 */
export function buildClientPageAdoptionIntents(input: {
  pages: readonly AdoptableClientHostedPage[]
  authority: ClientHostedPageAdoptionAuthority
  lease: ClientHostedPageAdoptionLease
  /** The key a page in that workspace would be created under now, not the one it was created under. */
  executionHostKeyByWorkspaceId: ReadonlyMap<string, string>
}): readonly BrowserHostRuntimePageIntent[] {
  const ordered = [...input.pages].sort(
    (left, right) => left.pageHostGeneration - right.pageHostGeneration
  )
  const baseGeneration = ordered.reduce(
    (highest, page) => Math.max(highest, page.pageHostGeneration),
    0
  )
  return ordered.flatMap((page, index) => {
    const executionHostKey = input.executionHostKeyByWorkspaceId.get(page.workspaceId)
    if (executionHostKey === undefined) {
      return []
    }
    return [
      Object.freeze({
        authorityRuntimeId: input.authority.authorityRuntimeId,
        authorityEpoch: input.authority.authorityEpoch,
        browserHostClientId: input.lease.browserHostClientId,
        browserHostGeneration: input.lease.browserHostGeneration,
        pageHostGeneration: baseGeneration + index + 1,
        browserPageId: page.browserPageId,
        browserProfileId: page.browserProfileId,
        executionHostKey,
        workspaceId: page.workspaceId
      })
    ]
  })
}

type ReconciliationOptions = {
  maxConcurrency?: number
  actionTimeoutMs?: number
  signal?: AbortSignal
}

export type BrowserHostClientPageAdoptionDependencies = {
  state: BrowserHostLeaseState
  reconciliations: {
    adopt(
      state: BrowserHostLeaseState,
      intents: readonly BrowserHostRuntimePageIntent[],
      options: ReconciliationOptions
    ): Promise<unknown>
  }
  placements: { getPlacement(browserPageId: string): RuntimeBrowserPlacement | undefined }
  executionHostGrants: Map<string, BrowserClientPageExecutionHostGrant>
}

/**
 * Runs a reconciliation that takes back pages this runtime never placed, holding the execution-host
 * grants the plan requires and returning the page ids that ended up placed.
 *
 * Grants are settled against the committed placements rather than the reconciliation's outcome: a
 * run that fails part way still leaves the pages it did place, and releasing their grants would
 * strand a live page behind a revoked tunnel.
 */
export async function adoptBrowserHostClientPages(
  intents: readonly BrowserHostRuntimePageIntent[],
  options: ReconciliationOptions,
  dependencies: BrowserHostClientPageAdoptionDependencies
): Promise<readonly string[]> {
  if (intents.length === 0) {
    return []
  }
  const grants = intents.map((intent) => ({
    intent,
    grant: dependencies.state.executionHostGrants.retain(intent.executionHostKey)
  }))
  await dependencies.reconciliations
    .adopt(dependencies.state, intents, options)
    .catch(() => undefined)
  const adopted: string[] = []
  for (const { intent, grant } of grants) {
    const placement = dependencies.placements.getPlacement(intent.browserPageId)
    if (
      placement?.kind === 'client' &&
      placement.pageHostGeneration === intent.pageHostGeneration &&
      !dependencies.executionHostGrants.has(intent.browserPageId)
    ) {
      dependencies.executionHostGrants.set(intent.browserPageId, {
        placement,
        executionHostKey: intent.executionHostKey,
        release: grant.release
      })
      adopted.push(intent.browserPageId)
    } else {
      grant.release()
    }
  }
  return adopted
}
