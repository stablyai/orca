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
import { worktreePathComparisonKey } from './ipc/worktree-path-comparison'
import {
  retirementHostIdentity,
  retirementNamespaceKey,
  retirementNamespaceKeysToRead,
  type SshTargetLookup
} from './worktree-retirement-namespace'
import { discoverRetiredWorktreeNames } from './worktree-retirement-discovery'
import { runRetirementBackfillScan } from './worktree-retirement-backfill-scan'
import { hasCachedWslHome, parseWslPath } from './wsl'

const RETIREMENT_PROBE_NAME = 'orca-retirement-probe'

type RetirementReadStore = {
  getRetiredWorktreeNameRegistry(repoId: string): RetiredNameRegistry
  getRetiredWorktreeNameRegistryForNamespace?(namespaceKey: string): RetiredNameRegistry
  getSshTarget?: SshTargetLookup
}
type RetirementBackfillStore = {
  mergeRetiredWorktreeNames(repoId: string, names: Iterable<string>): boolean
}
type RetirementWriteStore = {
  addRetiredWorktreeName(repoId: string, name: string): void
  mergeRetiredWorktreeNamesForNamespace?(namespaceKey: string, names: Iterable<string>): boolean
  getSshTarget?: SshTargetLookup
}
type RetirementPathSettings = Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDir'>

/** Only canonical generator output is persisted. Collision retries advance canonical tiers, so a
 *  repeat-suffixed path can never be generated again and needs no permanent registry entry. */
export function normalizeRetirableGeneratedName(name: string): string | null {
  const normalized = name.trim().toLowerCase()
  return normalized.length <= 256 && creatureNameTier(normalized) !== null ? normalized : null
}

/** A sparse create error carries this marker only when its rollback also failed, leaving the path
 *  occupied even though creation rejected. */
export function failedWorktreeCreationNeedsRetirement(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'cleanupFailed') === true
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

// Why: the create path and every suggestion refresh ask for the same namespace identity.
const COLLISION_KEY_CACHE_MAX = 512
const collisionKeyCache = new Map<string, string>()

export function resetRetirementCollisionKeyCacheForTests(): void {
  collisionKeyCache.clear()
}

/** Identifies the cwd namespace a repo creates workspaces into. Two repos that would place a
 *  workspace of the same name at the same path share retirements; independent paths do not. */
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
    settings.nestWorkspaces ? 'nested' : 'flat'
  ].join('\u0000')
  const cached = collisionKeyCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  const key = retirementNamespaceKey(hostIdentity, await getRetirementProbePath(repo, settings))
  // Why not always cache: only the WSL home *success* path is cached upstream, so a stopped distro
  // yields a fallback namespace. Memoizing that would strand the repo there for the whole session.
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

/** True when the repo executes on an Orca-provisioned on-demand runtime, whose address and
 *  filesystem are both replaced on every provision. */
function isRuntimeOwnedRetirementHost(repo: Repo): boolean {
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  return parsed?.kind === 'ssh' && isRuntimeOwnedSshTargetId(parsed.targetId)
}

/** Bound so the store's own method keeps its receiver when passed down as a lookup. */
function sshTargetLookup(store: { getSshTarget?: SshTargetLookup }): SshTargetLookup {
  return (targetId) => store.getSshTarget?.(targetId)
}

/** Reads the union of both copies: the repo-id row (lost on remove) and the path-derived namespace
 *  row (lost on a workspace-path settings change). Neither alone survives both events. */
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

/** Stored per repo id, which is stable, but read across every repo that creates into the same cwd
 *  namespace — that is where a reissued name would actually collide.
 *
 *  The peer scan is deliberately lazy: a repo's own retirements never touch a path, and a peer's
 *  namespace is derived only once that peer is known to hold retirements. */
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
  let collisionKey: string | null = null
  try {
    collisionKey = await ensureRetiredWorktreeNamesBackfilled(store, repo, settings)
  } catch (error) {
    console.warn(`[worktrees] retirement backfill failed for repo ${repo.id}:`, error)
  }
  let registry = store.getRetiredWorktreeNameRegistry(repo.id)
  if (store.getRetiredWorktreeNameRegistryForNamespace) {
    collisionKey ??= await getRetirementCollisionKey(repo, settings, lookup)
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
    collisionKey ??= await getRetirementCollisionKey(repo, settings, lookup)
    if ((await getRetirementCollisionKey(candidate, settings, lookup)) !== collisionKey) {
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
  // Why local too: the repo-id row dies with the project, and the on-disk backfill cannot recover a
  // name whose only surviving history is a Codex rollout file rather than a directory.
  //
  // On-demand runtimes are the exception: the address is part of the key and changes on every
  // provision, so a mirror written here is unreadable after the next one while still minting a
  // namespace per run — spending the capped slots that local and SSH projects depend on. The
  // repo-id row still records the name, so only a remove/re-add *within* one provision loses
  // anything, and that VM's filesystem is discarded shortly after regardless.
  if (
    isFolderRepo(repo) ||
    !store.mergeRetiredWorktreeNamesForNamespace ||
    isRuntimeOwnedRetirementHost(repo)
  ) {
    return
  }
  try {
    const namespaceKey = await getRetirementCollisionKey(repo, settings, sshTargetLookup(store))
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

/** Async throughout on purpose: this runs on composer open, not just at create time, and the sync
 *  probe would resolve a WSL home with a blocking `wsl.exe` call — up to 5s of frozen main process
 *  on a stopped distro. Resolving it here also warms the shared cache for later sync callers. */
export async function ensureRetiredWorktreeNamesBackfilled(
  store: RetirementBackfillStore,
  repo: Repo,
  settings: RetirementPathSettings
): Promise<string | null> {
  // Remote workspaces keep their agent state on the execution host, which this scan cannot see, so
  // a re-added remote repo does not recover its retirements the way a local one does.
  //
  // Why the host id and not `connectionId`: a runtime-owned repo carries `executionHostId` with no
  // `connectionId`, so a connectionId check calls it local, scans THIS machine's directories, and
  // files the result under the runtime's namespace — retiring names never used there while missing
  // the ones that were.
  if (isFolderRepo(repo) || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const probePath = await computeWorktreePathAsync(
    RETIREMENT_PROBE_NAME,
    repo.path,
    getWorktreePathSettings(repo, settings)
  )
  const scanKey = `${getRepoExecutionHostId(repo)}:${worktreePathComparisonKey(probePath)}`
  const names = await runRetirementBackfillScan(store, scanKey, () =>
    discoverRetiredWorktreeNames({ workspaceRoots: [parentPath(probePath)] })
  )
  // Why the merge sits outside the cached scan: the scan is per cwd namespace but the registry is
  // per repo, so every repo that asks must receive it — not only the one that triggered it.
  store.mergeRetiredWorktreeNames(repo.id, names)
  return scanKey
}
