import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { WorktreeVisibilitySourceMatcher } from '../../shared/worktree/visibility-sources'
import {
  toDetectedWorktree,
  buildKnownOrcaWorkspaceLayouts,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../shared/worktree/ownership'
import type { RuntimeStore } from './runtime-store-contract'

export function toRuntimeDetectedWorktree(
  store: RuntimeStore | null,
  repo: Repo,
  worktree: Worktree,
  matcher?: WorktreeVisibilitySourceMatcher,
  sourceDefaultsSupported = true,
  providedSettings?: ReturnType<RuntimeStore['getSettings']>,
  providedMeta?: WorktreeMeta | null
) {
  const settings = providedSettings ?? store?.getSettings()
  if (!settings) {
    return {
      ...worktree,
      ownership: 'unknown-legacy' as const,
      selectedCheckout: false,
      visible: true
    }
  }
  const visibilityDefaults = runtimeVisibilityDefaults(sourceDefaultsSupported, settings)
  return toDetectedWorktree({
    repo,
    worktree,
    meta:
      providedMeta === undefined
        ? store?.getWorktreeMeta(worktree.id)
        : (providedMeta ?? undefined),
    settings: { ...settings, worktreeVisibilityDefaults: visibilityDefaults },
    knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo),
    isLegacyRepoForVisibility: isLegacyRepoForExternalWorktreeVisibility(repo),
    worktreeVisibilitySourceMatcher: matcher
  })
}

export function runtimeVisibilityDefaults(
  sourceDefaultsSupported: boolean,
  settings?: ReturnType<RuntimeStore['getSettings']>
) {
  const defaults = settings?.worktreeVisibilityDefaults
  return sourceDefaultsSupported || !defaults ? defaults : { external: defaults.external }
}
