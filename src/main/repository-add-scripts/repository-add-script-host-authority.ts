import { adoptEndpointRepo } from '../../shared/endpoint-catalog-adoption'
import {
  isRepoOnCatalogHost,
  parseRoutableExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import { normalizeStoredRepositoryAddScript } from '../../shared/repository-add-script-settings'
import {
  resolveLocalWorkspaceRuntime,
  type ProjectRuntimeResolutionStore
} from '../local-project-runtime-resolution'
import { isRepositoryAddScriptPlatformSupported } from './repository-add-script-runner'
import type {
  RepositoryAddScriptDependencies,
  RepositoryAddScriptRun
} from './repository-add-script-service'
import { resolveRepositoryAddScriptTarget } from './repository-add-script-target'

export type RepositoryAddScriptHostStore = {
  getRepo: (id: string) => Repo | undefined
  getProjects?: ProjectRuntimeResolutionStore['getProjects']
  getSettings: () => Partial<
    Pick<GlobalSettings, 'repositoryAddScript' | 'localWindowsRuntimeDefault'>
  >
}

export type RepositoryAddScriptHostAuthorityOptions = {
  getStore: () => RepositoryAddScriptHostStore | null
  readMachineName: () => string
}

export type RepositoryAddScriptHostAuthority = Omit<
  RepositoryAddScriptDependencies,
  'runScript'
> & {
  /** In-memory projection of a just-inserted row for the alias it was registered through. */
  getRegistrationRepo: (repo: Repo, hostId: ExecutionHostId) => Repo | null
  /** Exact executor identity for a run; throws for anything but `local` or a `runtime:` alias. */
  requireExecutorHostId: (hostId: ExecutionHostId) => ExecutionHostId
  /** The run's placement from its stored row; throws once that row is no longer this host's. */
  requireRunRuntime: (run: RepositoryAddScriptRun) => ProjectExecutionRuntimeResolution
}

// `runtime:E` is the alias a paired client reaches this host through; SSH hosts run elsewhere.
function toHostAlias(hostId: ExecutionHostId): ExecutionHostId | null {
  const parsed = parseRoutableExecutionHostId(hostId)
  return parsed?.id === hostId && (parsed.kind === 'local' || parsed.kind === 'runtime')
    ? parsed.id
    : null
}

function projectForAlias(repo: Repo, alias: ExecutionHostId): Repo {
  const parsed = parseRoutableExecutionHostId(alias)
  return adoptEndpointRepo(
    parsed?.kind === 'runtime'
      ? { kind: 'environment', environmentId: parsed.environmentId }
      : { kind: 'local' },
    repo
  )
}

/**
 * Binds the add-script service to this host's catalog. Authority always comes from the stored row,
 * never a path match or an alias stamp: only an unstamped or `local` row with no SSH connection
 * is this host's to run in, and the alias projection is never written back.
 */
export function createRepositoryAddScriptHostAuthority(
  options: RepositoryAddScriptHostAuthorityOptions
): RepositoryAddScriptHostAuthority {
  function storedRow(repoId: string): { store: RepositoryAddScriptHostStore; repo: Repo } | null {
    const store = options.getStore()
    const repo = store?.getRepo(repoId)
    return store && repo?.id === repoId && !isFolderRepo(repo) && isRepoOnCatalogHost(repo)
      ? { store, repo }
      : null
  }

  // Resolved from the stored row so a new repo with no project still takes the global default.
  function resolveRuntime(repoId: string, path: string): ProjectExecutionRuntimeResolution | null {
    const row = storedRow(repoId)
    if (!row || row.repo.path !== path) {
      return null
    }
    return resolveLocalWorkspaceRuntime(row.store, row.repo, row.repo.path) ?? null
  }

  function getRepo(repoId: string, hostId: ExecutionHostId): Repo | null {
    const alias = toHostAlias(hostId)
    const row = alias ? storedRow(repoId) : null
    return alias && row ? projectForAlias(row.repo, alias) : null
  }

  return {
    getOwner: (hostId) => {
      const alias = toHostAlias(hostId)
      return alias
        ? {
            hostId: alias,
            label: options.readMachineName(),
            available: options.getStore() !== null,
            supported: isRepositoryAddScriptPlatformSupported(process.platform)
          }
        : null
    },
    getRepo,
    repoExists: (repoId) => {
      const store = options.getStore()
      if (!store) {
        throw new Error('Repository catalog is unavailable.')
      }
      return store.getRepo(repoId) !== undefined
    },
    getScript: () => {
      const store = options.getStore()
      return store
        ? normalizeStoredRepositoryAddScript(store.getSettings().repositoryAddScript)
        : null
    },
    resolveTarget: (repo, hostId) => {
      const runtime = toHostAlias(hostId) ? resolveRuntime(repo.id, repo.path) : null
      return runtime ? resolveRepositoryAddScriptTarget(repo.path, runtime, process.platform) : null
    },
    getRegistrationRepo: (repo, hostId) => {
      const projected = getRepo(repo.id, hostId)
      return projected?.path === repo.path ? projected : null
    },
    requireExecutorHostId: (hostId) => {
      const alias = toHostAlias(hostId)
      if (!alias) {
        throw new Error('Repository add script owner is not this host.')
      }
      return alias
    },
    requireRunRuntime: (run) => {
      const runtime = toHostAlias(run.hostId) ? resolveRuntime(run.repoId, run.path) : null
      if (!runtime) {
        throw new Error('Repository add script repository is no longer on this host.')
      }
      return runtime
    }
  }
}
