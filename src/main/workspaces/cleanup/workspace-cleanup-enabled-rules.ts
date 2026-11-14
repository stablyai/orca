import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import {
  resolveWorkspaceCleanupPolicy,
  WORKSPACE_CLEANUP_RULE_KEYS
} from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import { listWorkspaceCleanupOwnedRepos } from './workspace-cleanup-run-evidence'

/** One entry per rule on in a project this process cleans; a new entry means a rule was turned on or changed. */
export function listEnabledWorkspaceCleanupRules(store: RuntimeStore): Set<string> {
  const settings = store.getSettings()
  const enabled = new Set<string>()
  for (const repo of listWorkspaceCleanupOwnedRepos(store).values()) {
    const { rules } = resolveWorkspaceCleanupPolicy(settings, repo)
    for (const key of WORKSPACE_CLEANUP_RULE_KEYS) {
      if (rules[key].enabled) {
        // keepWhen decides what counts as local work, so loosening it can make a workspace removable.
        enabled.add(`${repo.id}:${key}:${JSON.stringify(rules[key])}:${rules.keepWhen}`)
      }
    }
  }
  return enabled
}
