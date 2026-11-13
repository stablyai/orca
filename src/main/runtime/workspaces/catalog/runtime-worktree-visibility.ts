import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { readRuntimeWorktreeMetadata } from './runtime-listing-metadata'
import {
  buildKnownOrcaWorkspaceLayouts,
  toDetectedWorktree
} from '../../../../shared/worktree/ownership'
import { isLegacyRepoForExternalWorktreeVisibility } from '../../../../shared/external-worktree-visibility'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources,
  type WorktreeVisibilitySourceMatcher
} from '../../../../shared/worktree/visibility-sources'
import {
  createRepoRowExecutionHostLookup,
  type RepoRowExecutionHostLookup
} from '../../../../shared/execution-host/worktree-execution-host-resolution'
import { resolveWorktreeHostRouting } from './worktree-launch-host-repo'
import { resolveConfiguredWorktreeBasePaths } from '../../../../shared/worktree/configured-worktree-base-path'

export function buildRuntimeWorktreeVisibilityMatchers(
  repos: readonly Repo[],
  resolved: readonly Worktree[],
  visibilityDefaults: Parameters<typeof resolveCustomWorktreeVisibilitySources>[1]
) {
  const owners = createRepoRowExecutionHostLookup(repos)
  const pathsByRepo = new Map<string, string[]>()
  for (const worktree of resolved) {
    const owner = resolveWorktreeHostRouting(repos, worktree, owners)
    if (owner.kind !== 'resolved') {
      continue
    }
    const key = getRepoHostIdentityForParts(worktree.repoId, owner.hostId)
    const paths = pathsByRepo.get(key) ?? []
    paths.push(worktree.path)
    pathsByRepo.set(key, paths)
  }
  return new Map(
    repos.map((repo) => [
      getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo)),
      createWorktreeVisibilitySourceMatcher(
        [
          repo.path,
          ...(pathsByRepo.get(getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))) ??
            [])
        ],
        resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
        resolveConfiguredWorktreeBasePaths(repo)
      )
    ])
  )
}

export function projectRuntimeDetectedWorktree(
  getStore: () => RuntimeStore | null,
  repo: Repo,
  worktree: Worktree,
  matcher?: WorktreeVisibilitySourceMatcher,
  defaultsSupported = true,
  settingsOverride?: ReturnType<RuntimeStore['getSettings']>,
  providedMeta?: WorktreeMeta | null,
  repoOwnerCount?: number
) {
  const store = getStore()
  const settings = settingsOverride ?? store?.getSettings()
  if (!settings) {
    return {
      ...worktree,
      ownership: 'unknown-legacy' as const,
      selectedCheckout: false,
      visible: !worktree.isBare
    }
  }
  const visibilityDefaults = readRuntimeWorktreeVisibilityDefaults(
    getStore,
    defaultsSupported,
    settings
  )
  const meta =
    providedMeta === undefined
      ? store
        ? readRuntimeWorktreeMetadata(store, repo, worktree.id, repoOwnerCount)
        : undefined
      : (providedMeta ?? undefined)
  const detected = toDetectedWorktree({
    repo,
    worktree,
    meta,
    settings: { ...settings, worktreeVisibilityDefaults: visibilityDefaults },
    knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo),
    isLegacyRepoForVisibility: isLegacyRepoForExternalWorktreeVisibility(repo),
    worktreeVisibilitySourceMatcher: matcher
  })
  return detected
}

export function readRuntimeWorktreeVisibilityDefaults(
  getStore: () => RuntimeStore | null,
  defaultsSupported: boolean,
  settingsOverride?: ReturnType<RuntimeStore['getSettings']>
) {
  const defaults =
    settingsOverride !== undefined
      ? settingsOverride.worktreeVisibilityDefaults
      : getStore()?.getSettings().worktreeVisibilityDefaults
  return defaultsSupported || !defaults ? defaults : { external: defaults.external }
}

export function isRuntimeWorktreeVisible(
  getStore: () => RuntimeStore | null,
  worktree: Worktree,
  matcher: WorktreeVisibilitySourceMatcher | undefined,
  defaultsSupported: boolean,
  settingsOverride: ReturnType<RuntimeStore['getSettings']> | undefined,
  repoLookup: RepoRowExecutionHostLookup<Repo>
): boolean {
  const routing = resolveWorktreeHostRouting<Repo>([], worktree, repoLookup)
  const repo = routing.kind === 'resolved' ? routing.repo : undefined
  return repo
    ? projectRuntimeDetectedWorktree(
        getStore,
        repo,
        worktree,
        matcher,
        defaultsSupported,
        settingsOverride,
        undefined,
        repoLookup.rowsFor(repo.id).length
      ).visible
    : !worktree.isBare
}
