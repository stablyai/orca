import {
  PLUGIN_BLOCKED_CODE,
  PLUGIN_NOT_FOUND_CODE,
  PluginCliError
} from '../../shared/plugins/approval/plugin-cli-approval'
import { COMMUNITY_MARKETPLACE_GIT_SOURCE } from '../../shared/plugins/catalog/plugin-install-link'
import {
  isSameGitRepository,
  splitQualifiedPluginKey
} from '../../shared/plugins/catalog/plugin-marketplace'
import { pluginRepositoryOrigin } from '../../shared/plugins/catalog/plugin-repository-link'
import { parsePluginGitInstallInput } from '../../shared/plugins/installation/plugin-git-install-input'
import type { PluginLockEntry } from '../../shared/plugins/installation/plugin-install-lockfile'
import type {
  PluginMarketplaceInstaller,
  PluginMarketplaceInstallPreview
} from './catalog/plugin-marketplace-installer'
import { marketplaceInstallOf } from './catalog/plugin-marketplace-install-origin'
import type {
  PluginMarketplaceListing,
  PluginMarketplaceService,
  PluginMarketplaceSourceState
} from './catalog/plugin-marketplace-service'
import {
  assertInstallAllowed,
  gitFailure,
  installFailed,
  type PluginCliCandidateHost,
  type PluginCliInstallCandidate
} from './plugin-cli-install-candidates'

export type PluginCliCatalogs = {
  marketplace: Pick<
    PluginMarketplaceService,
    'listSources' | 'listPlugins' | 'refreshSource' | 'refreshAll' | 'addSource' | 'removeSource'
  >
  installer: Pick<
    PluginMarketplaceInstaller,
    'preview' | 'install' | 'previewInstalledUpdate' | 'readInstallLockfile'
  >
}

/** `official`, `community`, a catalog id, its name, or its repository in any accepted spelling. */
export function matchesCatalogSelector(
  state: PluginMarketplaceSourceState,
  selector: string
): boolean {
  const wanted = selector.trim()
  if (wanted === 'official') {
    return state.official
  }
  if (wanted === 'community') {
    return isSameGitRepository(state.source.url, COMMUNITY_MARKETPLACE_GIT_SOURCE.url)
  }
  if (state.id === wanted || state.marketplace?.name.toLowerCase() === wanted.toLowerCase()) {
    return true
  }
  const parsed = parsePluginGitInstallInput(wanted)
  return parsed.ok && isSameGitRepository(state.source.url, parsed.url)
}

function catalogNextSteps(): string[] {
  return [
    '`orca plugin catalog list` shows the catalogs on this Orca host.',
    'Install straight from the repository instead: `orca plugin install <owner>/<repo>`.'
  ]
}

async function findListing(
  catalogs: PluginCliCatalogs,
  pluginKey: string,
  selector: string | undefined
): Promise<{ listing: PluginMarketplaceListing; state: PluginMarketplaceSourceState }> {
  const sources = await catalogs.marketplace.listSources()
  const allowed = selector
    ? sources.filter((state) => matchesCatalogSelector(state, selector))
    : sources
  if (selector && allowed.length === 0) {
    throw new PluginCliError(
      PLUGIN_NOT_FOUND_CODE,
      `No catalog on this Orca host matches ${selector}.`,
      {
        catalog: selector,
        nextSteps: [
          '`orca plugin catalog list` shows the catalogs; `orca plugin catalog add <url>` adds one.'
        ]
      }
    )
  }
  const read = async (): Promise<PluginMarketplaceListing[]> =>
    (await catalogs.marketplace.listPlugins()).filter(
      (listing) =>
        listing.pluginKey === pluginKey &&
        allowed.some((state) => state.id === listing.marketplaceSourceId)
    )
  let listings = await read()
  if (listings.length === 0) {
    // Why refresh only on a miss: a cached catalog answers most installs without the network.
    await Promise.all(
      allowed.map((state) => catalogs.marketplace.refreshSource(state.id).catch(() => undefined))
    )
    listings = await read()
  }
  const preferred = listings.find((listing) => listing.official) ?? null
  if (!preferred && listings.length > 1) {
    throw new PluginCliError(
      'invalid_argument',
      `${pluginKey} is listed by more than one catalog; pass --catalog to pick one.`,
      {
        catalogs: listings.map((listing) => ({
          id: listing.marketplaceSourceId,
          name: listing.marketplaceName
        })),
        nextSteps: [`Run again with --catalog <id> using one of the catalogs listed above.`]
      }
    )
  }
  const listing = preferred ?? listings[0]
  const state = listing && sources.find((source) => source.id === listing.marketplaceSourceId)
  if (!listing || !state) {
    throw new PluginCliError(
      PLUGIN_NOT_FOUND_CODE,
      `No catalog on this Orca host lists ${pluginKey}.`,
      { pluginKey, nextSteps: catalogNextSteps() }
    )
  }
  return { listing, state }
}

function candidateFromPreview(
  host: PluginCliCandidateHost,
  catalogs: PluginCliCatalogs,
  preview: PluginMarketplaceInstallPreview,
  state: PluginMarketplaceSourceState,
  options: { requireInstalled?: boolean }
): PluginCliInstallCandidate {
  if (preview.blockedByKillList) {
    throw new PluginCliError(
      PLUGIN_BLOCKED_CODE,
      `${preview.pluginKey} is blocked by Orca's safety list: ${preview.blockedByKillList.reason}`,
      {
        pluginKey: preview.pluginKey,
        nextSteps: ['Do not try to install this plugin another way.']
      }
    )
  }
  assertInstallAllowed(host, preview.pluginKey, {
    kind: 'marketplace',
    marketplace: { ...state.source, resolvedCommit: preview.marketplaceCommit },
    plugin: preview.source
  })
  const { source } = preview
  return {
    pluginKey: preview.pluginKey,
    manifest: preview.manifest,
    contentHash: preview.contentHash,
    consentFingerprint: preview.consentFingerprint,
    resolvedCommit: preview.resolvedCommit,
    vmRecipeIdentities: preview.vmRecipeIdentities,
    source: {
      kind: 'catalog',
      official: preview.official && state.official,
      publisher: splitQualifiedPluginKey(preview.pluginKey)?.publisher ?? null,
      repository: pluginRepositoryOrigin(source.url, source.path)?.repository ?? null,
      url: source.url,
      ref: source.ref,
      commit: preview.resolvedCommit,
      path: null,
      catalog: {
        id: state.id,
        name: preview.marketplaceName,
        url: state.source.url,
        official: state.official
      }
    },
    location: {
      kind: 'repository',
      url: source.url,
      ...(source.path ? { path: source.path } : {})
    },
    install: () => catalogs.installer.install(preview, { ...options, trigger: 'catalog' }),
    dispose: async () => undefined
  }
}

export async function catalogInstallCandidate(
  host: PluginCliCandidateHost,
  catalogs: PluginCliCatalogs,
  pluginKey: string,
  selector: string | undefined
): Promise<PluginCliInstallCandidate> {
  const { listing, state } = await findListing(catalogs, pluginKey, selector)
  const preview = await catalogs.installer
    .preview(listing.marketplaceSourceId, pluginKey)
    .catch((error: unknown) => {
      throw gitFailure(host, listing.source.url, error)
    })
  return candidateFromPreview(host, catalogs, preview, state, {})
}

/** The release the plugin's own catalog offers now, after refreshing that catalog. */
export async function catalogUpdateCandidate(
  host: PluginCliCandidateHost,
  catalogs: PluginCliCatalogs,
  entry: PluginLockEntry
): Promise<PluginCliInstallCandidate> {
  const installed = marketplaceInstallOf(entry)
  const state = installed
    ? (await catalogs.marketplace.listSources()).find((source) => source.id === installed.sourceId)
    : undefined
  if (!installed || !state) {
    throw installFailed(
      `${entry.pluginKey} was installed from a catalog that is no longer on this Orca host.`,
      { pluginKey: entry.pluginKey }
    )
  }
  await catalogs.marketplace.refreshSource(state.id).catch((error: unknown) => {
    throw gitFailure(host, state.source.url, error)
  })
  const preview = await catalogs.installer
    .previewInstalledUpdate(entry.pluginKey)
    .catch((error: unknown) => {
      throw gitFailure(host, installed.plugin.url, error)
    })
  return candidateFromPreview(host, catalogs, preview, state, { requireInstalled: true })
}
