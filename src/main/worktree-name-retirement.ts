import {
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../shared/execution-host'
import {
  creatureNameTier,
  EMPTY_RETIRED_NAME_REGISTRY,
  isEmptyRetiredNameRegistry,
  mergeRetiredNameRegistries,
  type RetiredNameRegistry
} from '../shared/worktree/retired-name-registry'
import { isFolderRepo } from '../shared/repo-kind'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { Repo } from '../shared/repo-types'
import {
  computeRemoteWorktreePath,
  computeWorktreePathAsync,
  getWorktreePathSettings,
  hasRepoWorktreeBasePath
} from './ipc/worktree-logic'
import { worktreePathComparisonKey } from './worktree-path-comparison-key'
import {
  retirementHostIdentity,
  retirementNamespaceKey,
  retirementNamespaceKeysToRead,
  type SshTargetLookup
} from './worktree-retirement-namespace'
import { discoverRetiredWorktreeNames } from './worktree-retirement-discovery'
import { runRetirementBackfillScan } from './worktree-retirement-backfill-scan'
import { hasCachedWslHome, parseWslPath } from './wsl'
import { getWorktreeMirrorDistro } from './project-runtime-git-options'
import type { ProjectRuntimeResolutionStore } from './local-project-runtime-resolution'

const RETIREMENT_PROBE_NAME = 'orca-retirement-probe'

type RetirementRuntimeStore = {
  getProjects?: ProjectRuntimeResolutionStore['getProjects']
  getSettings?: ProjectRuntimeResolutionStore['getSettings']
}
type RetirementReadStore = RetirementRuntimeStore & {
  getRetiredWorktreeNameRegistry(repoId: string): RetiredNameRegistry
  getRetiredWorktreeNameRegistryForNamespace?(namespaceKey: string): RetiredNameRegistry
  getSshTarget?: SshTargetLookup
}
type RetirementBackfillStore = RetirementRuntimeStore & {
  mergeRetiredWorktreeNames(repoId: string, names: Iterable<string>): boolean
}
type RetirementWriteStore = RetirementRuntimeStore & {
  addRetiredWorktreeName(repoId: string, name: string): void
  mergeRetiredWorktreeNamesForNamespace?(namespaceKey: string, names: Iterable<string>): boolean
  getSshTarget?: SshTargetLookup
}
export function hasRetiredNameRegistryStore<
  T extends RetirementRuntimeStore & Partial<RetirementReadStore & RetirementBackfillStore>
>(store: T): store is T & RetirementReadStore & RetirementBackfillStore {
  return (
    typeof store.getRetiredWorktreeNameRegistry === 'function' &&
    typeof store.mergeRetiredWorktreeNames === 'function'
  )
}
type RetirementPathSettings = Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDir'> & {
  wslMirrorDistro?: string
}

function withMirrorDistro(
  store: RetirementRuntimeStore,
  repo: Repo,
  settings: RetirementPathSettings
): RetirementPathSettings {
  const distro = getWorktreeMirrorDistro(store, repo)
  return distro ? { ...settings, wslMirrorDistro: distro } : settings
}

/** Persist canonical generator names only; repeat-suffixed collision fallbacks cannot be generated again. */
export function normalizeRetirableGeneratedName(name: string): string | null {
  const normalized = name.trim().toLowerCase()
  return normalized.length <= 256 && creatureNameTier(normalized) !== null ? normalized : null
}

/** Failed sparse rollback can leave the rejected create's path occupied. */
export function failedWorktreeCreationNeedsRetirement(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'cleanupFailed' in error &&
    error.cleanupFailed === true
  )
}

async function getRetirementProbePath(
  repo: Repo,
  settings: RetirementPathSettings
): Promise<string> {
  const pathSettings = getWorktreePathSettings(repo, settings)
  return repo.connectionId
    ? computeRemoteWorktreePath(RETIREMENT_PROBE_NAME, repo.path, pathSettings, {
        useConfiguredAbsolutePath: hasRepoWorktreeBasePath(repo)
      })
    : computeWorktreePathAsync(RETIREMENT_PROBE_NAME, repo.path, pathSettings)
}

export function getRemoteRetirementNamespaceKey(
  repo: Repo,
  settings: RetirementPathSettings,
  lookupSshTarget?: SshTargetLookup
): string | null {
  if (!repo.connectionId) {
    return null
  }
  const pathSettings = getWorktreePathSettings(repo, settings)
  const probePath = computeRemoteWorktreePath(RETIREMENT_PROBE_NAME, repo.path, pathSettings, {
    useConfiguredAbsolutePath: hasRepoWorktreeBasePath(repo)
  })
  return retirementNamespaceKey(retirementHostIdentity(repo, lookupSshTarget), probePath)
}

const COLLISION_KEY_CACHE_MAX = 512
const collisionKeyCache = new Map<string, string>()

export function resetRetirementCollisionKeyCacheForTests(): void {
  collisionKeyCache.clear()
}

/** Repos share retirements when their workspace names would occupy the same path. */
async function getRetirementCollisionKey(
  repo: Repo,
  settings: RetirementPathSettings,
  lookupSshTarget?: SshTargetLookup
): Promise<string> {
  const hostIdentity = retirementHostIdentity(repo, lookupSshTarget)
  const cacheKey = [
    hostIdentity,
    repo.path,
    repo.worktreeBasePath ?? '',
    settings.workspaceDir,
    settings.nestWorkspaces ? 'nested' : 'flat',
    settings.wslMirrorDistro ?? ''
  ].join('\u0000')
  const cached = collisionKeyCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  const key = retirementNamespaceKey(hostIdentity, await getRetirementProbePath(repo, settings))
  // Do not cache a stopped distro's fallback namespace; a later successful home probe can change it.
  const wsl = parseWslPath(repo.path)
  if (wsl && !hasCachedWslHome(wsl.distro)) {
    return key
  }
  if (collisionKeyCache.size >= COLLISION_KEY_CACHE_MAX) {
    collisionKeyCache.clear()
  }
  collisionKeyCache.set(cacheKey, key)
  return key
}

/** Provisioning replaces both runtime address and filesystem. */
function isRuntimeOwnedRetirementHost(repo: Repo): boolean {
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  return parsed?.kind === 'ssh' && isRuntimeOwnedSshTargetId(parsed.targetId)
}

function sshTargetLookup(store: { getSshTarget?: SshTargetLookup }): SshTargetLookup {
  return (targetId) => store.getSshTarget?.(targetId)
}

/** Repo-id storage survives path settings changes; namespace storage survives project removal. */
function readNamespaceRegistry(
  store: RetirementReadStore,
  repo: Repo,
  namespaceKey: string,
  lookup: SshTargetLookup
): RetiredNameRegistry {
  let registry = EMPTY_RETIRED_NAME_REGISTRY
  for (const key of retirementNamespaceKeysToRead(repo, namespaceKey, lookup)) {
    const stored = store.getRetiredWorktreeNameRegistryForNamespace?.(key)
    registry = stored ? mergeRetiredNameRegistries(registry, stored) : registry
  }
  return registry
}

/** Resolve peer namespaces lazily, only for repos with retirements to share. */
export async function getRetiredNameRegistryForRepo(
  store: RetirementReadStore & RetirementBackfillStore,
  repo: Repo,
  repos: readonly Repo[],
  settings: RetirementPathSettings
): Promise<RetiredNameRegistry> {
  if (isFolderRepo(repo)) {
    return EMPTY_RETIRED_NAME_REGISTRY
  }
  const lookup = sshTargetLookup(store)
  const pathSettings = withMirrorDistro(store, repo, settings)
  let collisionKey: string | null = null
  try {
    collisionKey = await ensureRetiredWorktreeNamesBackfilled(store, repo, pathSettings)
  } catch (error) {
    console.warn(`[worktrees] retirement backfill failed for repo ${repo.id}:`, error)
  }
  let registry = store.getRetiredWorktreeNameRegistry(repo.id)
  if (store.getRetiredWorktreeNameRegistryForNamespace) {
    collisionKey ??= await getRetirementCollisionKey(repo, pathSettings, lookup)
    registry = mergeRetiredNameRegistries(
      registry,
      readNamespaceRegistry(store, repo, collisionKey, lookup)
    )
  }
  for (const candidate of repos) {
    if (candidate.id === repo.id || isFolderRepo(candidate)) {
      continue
    }
    const candidateRegistry = store.getRetiredWorktreeNameRegistry(candidate.id)
    if (isEmptyRetiredNameRegistry(candidateRegistry)) {
      continue
    }
    collisionKey ??= await getRetirementCollisionKey(repo, pathSettings, lookup)
    if (
      (await getRetirementCollisionKey(
        candidate,
        withMirrorDistro(store, candidate, settings),
        lookup
      )) !== collisionKey
    ) {
      continue
    }
    registry = mergeRetiredNameRegistries(registry, candidateRegistry)
  }
  return registry
}

export async function retireGeneratedWorktreeName(
  store: RetirementWriteStore,
  repo: Repo,
  settings: RetirementPathSettings,
  name: string
): Promise<void> {
  store.addRetiredWorktreeName(repo.id, name)
  // Mirror outside the repo row so remove/re-add retains names that directory backfill cannot recover.
  // Ephemeral runtime endpoints would spend capped namespace slots on filesystems that are discarded anyway.
  if (
    isFolderRepo(repo) ||
    !store.mergeRetiredWorktreeNamesForNamespace ||
    isRuntimeOwnedRetirementHost(repo)
  ) {
    return
  }
  try {
    const namespaceKey = await getRetirementCollisionKey(
      repo,
      withMirrorDistro(store, repo, settings),
      sshTargetLookup(store)
    )
    store.mergeRetiredWorktreeNamesForNamespace(namespaceKey, [name])
  } catch (error) {
    console.warn(`[worktrees] failed to persist retirement namespace for ${repo.id}:`, error)
  }
}

function parentPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return separatorIndex < 0 ? '' : trimmed.slice(0, separatorIndex)
}

/** Resolve WSL homes asynchronously to avoid blocking the composer and warm later sync callers' cache. */
export async function ensureRetiredWorktreeNamesBackfilled(
  store: RetirementBackfillStore,
  repo: Repo,
  settings: RetirementPathSettings
): Promise<string | null> {
  // Agent state belongs to the execution host; a missing connectionId does not make a runtime repo local.
  if (isFolderRepo(repo) || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const probePath = await computeWorktreePathAsync(
    RETIREMENT_PROBE_NAME,
    repo.path,
    getWorktreePathSettings(repo, settings, settings.wslMirrorDistro)
  )
  const scanKey = `${getRepoExecutionHostId(repo)}:${worktreePathComparisonKey(probePath)}`
  const names = await runRetirementBackfillScan(store, scanKey, () =>
    discoverRetiredWorktreeNames({ workspaceRoots: [parentPath(probePath)] })
  )
  // Each repo must receive the names even when another repo already populated the namespace scan cache.
  store.mergeRetiredWorktreeNames(repo.id, names)
  return scanKey
}
