import type { Repo } from '../../shared/repo-types'
import {
  mergeRetiredNameRegistries,
  type RetiredNameRegistry
} from '../../shared/worktree/retired-name-registry'
import { getRemoteRetirementNamespaceKey } from '../worktree-name-retirement'
import { retirementNamespaceKeysToRead } from '../worktree-retirement-namespace'
import type { TransferProfileState } from './profile-project-state-file'

export function extractRetiredNameRegistriesByNamespace(
  sourceState: TransferProfileState,
  sourceRepo: Repo
): Record<string, RetiredNameRegistry> {
  const lookup = (targetId: string) =>
    sourceState.sshTargets.find((target) => target.id === targetId)
  const namespaceKey = getRemoteRetirementNamespaceKey(sourceRepo, sourceState.settings, lookup)
  if (!namespaceKey) {
    return {}
  }
  // Pre-identity keys travel too, folded onto the canonical one so the target profile holds a
  // single up-to-date entry.
  let merged: RetiredNameRegistry | null = null
  for (const key of retirementNamespaceKeysToRead(sourceRepo, namespaceKey, lookup)) {
    const registry = sourceState.retiredWorktreeNamesByNamespace?.[key]
    if (registry) {
      merged = merged ? mergeRetiredNameRegistries(merged, registry) : registry
    }
  }
  return merged ? { [namespaceKey]: merged } : {}
}

export function mergeRetiredNameRegistryMaps(
  base: Record<string, RetiredNameRegistry>,
  incoming: Record<string, RetiredNameRegistry>
): Record<string, RetiredNameRegistry> {
  const merged = { ...base }
  for (const [key, registry] of Object.entries(incoming)) {
    merged[key] = merged[key] ? mergeRetiredNameRegistries(merged[key], registry) : registry
  }
  return merged
}
