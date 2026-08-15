import type { Repo } from '../../shared/repo-types'
import {
  mergeRetiredNameRegistries,
  type RetiredNameRegistry
} from '../../shared/worktree/retired-name-registry'
import { getRemoteRetirementNamespaceKey } from '../worktree-name-retirement'
import type { TransferProfileState } from './profile-project-state-file'

export function extractRetiredNameRegistriesByNamespace(
  sourceState: TransferProfileState,
  sourceRepo: Repo
): Record<string, RetiredNameRegistry> {
  const namespaceKey = getRemoteRetirementNamespaceKey(sourceRepo, sourceState.settings)
  const registry = namespaceKey
    ? sourceState.retiredWorktreeNamesByNamespace?.[namespaceKey]
    : undefined
  return namespaceKey && registry ? { [namespaceKey]: registry } : {}
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
