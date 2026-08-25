import { normalizeRetirableGeneratedName } from '../../worktree-name-retirement'
import { recordRetirementNamespaceRegistry } from '../../worktree-retirement-namespace'
import {
  addRetiredNames,
  EMPTY_RETIRED_NAME_REGISTRY,
  type RetiredNameRegistry
} from '../../../shared/worktree/retired-name-registry'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type RetiredWorktreeNameRuntime = Pick<StoreRuntimeState, 'state'>

const retiredWorktreeNamePersistenceContext = Symbol('RetiredWorktreeNamePersistence')
type RetiredWorktreeNamePersistenceContext = {
  runtime: RetiredWorktreeNameRuntime
  scheduling: WriteSchedulingOperations
}

export class RetiredWorktreeNamePersistence {
  readonly [retiredWorktreeNamePersistenceContext]: RetiredWorktreeNamePersistenceContext

  constructor(runtime: RetiredWorktreeNameRuntime, scheduling: WriteSchedulingOperations) {
    this[retiredWorktreeNamePersistenceContext] = { runtime, scheduling }
  }

  getRetiredWorktreeNameRegistry(repoId: string): RetiredNameRegistry {
    const stored =
      this[retiredWorktreeNamePersistenceContext].runtime.state.retiredWorktreeNamesByRepo?.[repoId]
    return stored
      ? { exhaustedTiers: stored.exhaustedTiers, names: [...stored.names] }
      : EMPTY_RETIRED_NAME_REGISTRY
  }

  getRetiredWorktreeNameRegistryForNamespace(namespaceKey: string): RetiredNameRegistry {
    const stored =
      this[retiredWorktreeNamePersistenceContext].runtime.state.retiredWorktreeNamesByNamespace?.[
        namespaceKey
      ]
    return stored
      ? { exhaustedTiers: stored.exhaustedTiers, names: [...stored.names] }
      : EMPTY_RETIRED_NAME_REGISTRY
  }

  addRetiredWorktreeName(repoId: string, name: string): void {
    const normalized = normalizeRetirableGeneratedName(name)
    if (!repoId || !normalized) {
      return
    }
    applyRetiredWorktreeNames(this, repoId, [normalized])
  }

  mergeRetiredWorktreeNames(repoId: string, names: Iterable<string>): boolean {
    if (!repoId) {
      return false
    }
    const incoming = new Set<string>()
    for (const name of names) {
      const normalized = normalizeRetirableGeneratedName(name)
      if (normalized) {
        incoming.add(normalized)
      }
    }
    return incoming.size > 0 && applyRetiredWorktreeNames(this, repoId, incoming)
  }

  mergeRetiredWorktreeNamesForNamespace(namespaceKey: string, names: Iterable<string>): boolean {
    if (!namespaceKey) {
      return false
    }
    const normalized = new Set<string>()
    for (const name of names) {
      const candidate = normalizeRetirableGeneratedName(name)
      if (candidate) {
        normalized.add(candidate)
      }
    }
    const next = addRetiredNames(
      this.getRetiredWorktreeNameRegistryForNamespace(namespaceKey),
      normalized
    )
    if (!next) {
      return false
    }
    this[retiredWorktreeNamePersistenceContext].runtime.state.retiredWorktreeNamesByNamespace ??= {}
    recordRetirementNamespaceRegistry(
      this[retiredWorktreeNamePersistenceContext].runtime.state.retiredWorktreeNamesByNamespace,
      namespaceKey,
      next
    )
    scheduleSave(this[retiredWorktreeNamePersistenceContext].scheduling)
    return true
  }
}

export function applyRetiredWorktreeNames(
  owner: RetiredWorktreeNamePersistence,
  repoId: string,
  names: Iterable<string>
): boolean {
  const next = addRetiredNames(owner.getRetiredWorktreeNameRegistry(repoId), names)
  if (!next) {
    return false
  }
  owner[retiredWorktreeNamePersistenceContext].runtime.state.retiredWorktreeNamesByRepo ??= {}
  owner[retiredWorktreeNamePersistenceContext].runtime.state.retiredWorktreeNamesByRepo[repoId] =
    next
  scheduleSave(owner[retiredWorktreeNamePersistenceContext].scheduling)
  return true
}

export function installRetiredWorktreeNamePersistenceContext(
  target: object,
  source: RetiredWorktreeNamePersistence
): void {
  Object.defineProperty(target, retiredWorktreeNamePersistenceContext, {
    value: source[retiredWorktreeNamePersistenceContext]
  })
}
