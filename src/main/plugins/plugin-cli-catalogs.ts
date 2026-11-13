import {
  buildPluginCatalogApprovalRequest,
  PluginCatalogApprovalRequiredError
} from '../../shared/plugins/approval/plugin-catalog-cli-approval'
import {
  PLUGIN_NOT_FOUND_CODE,
  PluginCliError
} from '../../shared/plugins/approval/plugin-cli-approval'
import { isSameGitRepository } from '../../shared/plugins/catalog/plugin-marketplace'
import { parsePluginGitInstallInput } from '../../shared/plugins/installation/plugin-git-install-input'
import type { PluginMarketplaceSourceState } from './catalog/plugin-marketplace-service'
import { matchesCatalogSelector, type PluginCliCatalogs } from './plugin-cli-catalog-candidates'
import { gitFailure, type PluginCliCandidateHost } from './plugin-cli-install-candidates'
import { assertPluginSystemEnabled } from './plugin-dev-folders'

export type PluginCliCatalogEntry = {
  id: string
  url: string
  ref: string
  name: string | null
  owner: string | null
  official: boolean
  fetchedAt: number | null
  stale: boolean
  error: string | null
}

type CatalogDeps = {
  catalogs: PluginCliCatalogs
  host: Pick<PluginCliCandidateHost, 'executionHost'>
  service: Parameters<typeof assertPluginSystemEnabled>[0]
}

export function pluginCliCatalogEntry(state: PluginMarketplaceSourceState): PluginCliCatalogEntry {
  return {
    id: state.id,
    url: state.source.url,
    ref: state.source.ref,
    name: state.marketplace?.name ?? null,
    owner: state.marketplace?.owner ?? null,
    official: state.official,
    fetchedAt: state.marketplace?.fetchedAt ?? null,
    stale: state.stale,
    error: state.error ?? null
  }
}

export async function listPluginCatalogsFromCli(
  deps: CatalogDeps
): Promise<PluginCliCatalogEntry[]> {
  assertPluginSystemEnabled(deps.service)
  return (await deps.catalogs.marketplace.listSources()).map(pluginCliCatalogEntry)
}

/** Adds a catalog only with `--approve` for its exact URL and branch; re-adding just refreshes it. */
export async function addPluginCatalogFromCli(
  deps: CatalogDeps,
  input: { input: string; ref?: string; approvalFingerprint?: string }
): Promise<{ added: boolean; catalog: PluginCliCatalogEntry }> {
  assertPluginSystemEnabled(deps.service)
  const parsed = parsePluginGitInstallInput(input.input)
  if (!parsed.ok) {
    throw new PluginCliError(
      'invalid_argument',
      parsed.reason === 'git-url-credentials'
        ? "Remove the username or token from the URL. Orca uses the Orca host's own Git sign-in."
        : 'Pass the catalog repository as owner/repo, an https:// or ssh:// URL, or git@host:owner/repo.git.',
      { nextSteps: ['Fix the URL and run the command again.'] }
    )
  }
  const source = { kind: 'git' as const, url: parsed.url, ref: input.ref ?? (parsed.ref || 'main') }
  const existing = (await deps.catalogs.marketplace.listSources()).find(
    (state) => isSameGitRepository(state.source.url, source.url) && state.source.ref === source.ref
  )
  if (existing) {
    const refreshed = await deps.catalogs.marketplace.refreshSource(existing.id)
    return { added: false, catalog: pluginCliCatalogEntry(refreshed) }
  }
  const request = buildPluginCatalogApprovalRequest(source)
  if (input.approvalFingerprint !== request.approvalFingerprint) {
    throw new PluginCatalogApprovalRequiredError(request, input.approvalFingerprint !== undefined)
  }
  const added = await deps.catalogs.marketplace.addSource(source).catch((error: unknown) => {
    throw gitFailure(deps.host, source.url, error)
  })
  return { added: true, catalog: pluginCliCatalogEntry(added) }
}

/** Removing a catalog only takes trust away, so it needs no approval. Orca's own cannot be removed. */
export async function removePluginCatalogFromCli(
  deps: CatalogDeps,
  selector: string
): Promise<{ removed: PluginCliCatalogEntry }> {
  assertPluginSystemEnabled(deps.service)
  const matches = (await deps.catalogs.marketplace.listSources()).filter((state) =>
    matchesCatalogSelector(state, selector)
  )
  if (matches.length !== 1) {
    throw new PluginCliError(
      matches.length === 0 ? PLUGIN_NOT_FOUND_CODE : 'invalid_argument',
      matches.length === 0
        ? `No catalog on this Orca host matches ${selector}.`
        : `${selector} matches more than one catalog; pass its id.`,
      { nextSteps: ['`orca plugin catalog list` shows each catalog id.'] }
    )
  }
  const [state] = matches
  if (state.official) {
    throw new PluginCliError('invalid_argument', "Orca's official catalog cannot be removed.", {
      nextSteps: []
    })
  }
  await deps.catalogs.marketplace.removeSource(state.id)
  return { removed: pluginCliCatalogEntry(state) }
}
