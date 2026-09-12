import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationDormantStatePayload
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  isEmptyRetiredNameRegistry,
  mergeRetiredNameRegistries,
  type RetiredNameRegistry
} from '../../../shared/worktree/retired-name-registry'
import { getRemoteRetirementNamespaceKey } from '../../worktree-name-retirement'
import {
  replaceRetirementNamespaceHostIdentity,
  retirementHostIdentity,
  retirementNamespaceKeysToRead
} from '../../worktree-retirement-namespace'

export function collectOrcadMigrationRetirementNamespaces(
  state: PersistedState,
  catalog: OrcadMigrationCatalogPayload
): OrcadMigrationDormantStatePayload['retiredWorktreeNamespaces'] {
  const lookup = (targetId: string) => state.sshTargets.find((target) => target.id === targetId)
  const byDestination = new Map<
    string,
    { sourceNamespaceKeys: Set<string>; registry: RetiredNameRegistry }
  >()
  for (const repo of catalog.repositories) {
    const canonicalSource = getRemoteRetirementNamespaceKey(repo, state.settings, lookup)
    if (!canonicalSource) {
      continue
    }
    const sourceNamespaceKeys = retirementNamespaceKeysToRead(repo, canonicalSource, lookup).filter(
      (key) => state.retiredWorktreeNamesByNamespace?.[key] !== undefined
    )
    if (sourceNamespaceKeys.length === 0) {
      continue
    }
    const registry = sourceNamespaceKeys.reduce(
      (merged, key) =>
        mergeRetiredNameRegistries(
          merged,
          state.retiredWorktreeNamesByNamespace?.[key] ?? { exhaustedTiers: 0, names: [] }
        ),
      { exhaustedTiers: 0, names: [] } as RetiredNameRegistry
    )
    if (isEmptyRetiredNameRegistry(registry)) {
      continue
    }
    const namespaceKey = replaceRetirementNamespaceHostIdentity(
      canonicalSource,
      retirementHostIdentity(repo, lookup),
      LOCAL_EXECUTION_HOST_ID
    )
    if (!namespaceKey) {
      continue
    }
    const existing = byDestination.get(namespaceKey)
    byDestination.set(namespaceKey, {
      sourceNamespaceKeys: new Set([
        ...(existing?.sourceNamespaceKeys ?? []),
        ...sourceNamespaceKeys
      ]),
      registry: existing ? mergeRetiredNameRegistries(existing.registry, registry) : registry
    })
  }
  return [...byDestination.entries()]
    .map(([namespaceKey, entry]) => ({
      namespaceKey,
      sourceNamespaceKeys: [...entry.sourceNamespaceKeys].sort(compareKeys),
      registry: entry.registry
    }))
    .sort((left, right) => compareKeys(left.namespaceKey, right.namespaceKey))
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
