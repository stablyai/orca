import type { BrowserClientHostedPageInventory } from '../../../shared/browser-client-host-protocol'
import type { BrowserClientPageExecutionHostGrant } from './browser-host-client-page-creation'
import type { BrowserHostLeaseState } from './browser-host-lease-records'
import type { RuntimeBrowserPlacement } from '../../../shared/runtime-browser-placement'
import type { BrowserHostRuntimePageIntent } from './browser-host-page-reconciliation-plan'

/** Restart-adoptable inventory requires the workspace needed by its runtime record. */
export type AdoptableClientHostedPage = BrowserClientHostedPageInventory &
  Readonly<{ workspaceId: string }>

export type ClientHostedPageAdoptionCandidacy = {
  inventory: readonly BrowserClientHostedPageInventory[]
  browserHostClientId: string
  /** This process's id. An entry already naming it was placed by us, not by a predecessor. */
  authorityRuntimeId: string
  hasRuntimePage: (browserPageId: string) => boolean
}

/** Adopt only untracked predecessor pages; pages this process closed must not be resurrected. */
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

/** Every execution-host key changes on restart (runtime id or SSH provider epoch).
 * Close/restore instead of reclaiming: preserve the URL/tab, not the orphaned DOM.
 * Allocate above inventory generations so the placement registry accepts them. */
export function buildClientPageAdoptionIntents(input: {
  pages: readonly AdoptableClientHostedPage[]
  authority: ClientHostedPageAdoptionAuthority
  lease: ClientHostedPageAdoptionLease
  /** Current workspace key, not the predecessor's key. */
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

/** Retain grants for committed placements even after partial reconciliation failure; revocation would strand live pages. */
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
