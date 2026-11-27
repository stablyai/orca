import type {
  BaseRefDefaultResult,
  BaseRefSearchResult,
  Repo
} from '../../../shared/repository/repo-types'
import type { RuntimeRepoSearchRefs } from '../../../shared/worktree/catalog/runtime-worktree-contracts'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import {
  clampRepoSearchRefsLimit,
  getRepoSearchRefsProbeLimit,
  isRepoSearchRefsRequestLimit
} from '../../../shared/git/refs/repo-search-limits'
import type { RepoSearchRefSelectorForm } from '../../git/refs/resolution/legacy-ref-selectors'
import { getRepoRoutingConnectionId } from '../../../shared/execution-host/execution-host'
import { blockedWslDistroForPath } from '../../wsl/filesystem/wsl-unc-access-gate'

type RuntimeRepositoryRefQueryDependencies = {
  resolveRepo: (selector: string) => Promise<Repo>
}

export class RuntimeRepositoryRefQueries {
  constructor(private readonly deps: RuntimeRepositoryRefQueryDependencies) {}

  async search(
    repoSelector: string,
    query: string,
    limit: number,
    selectorForm: RepoSearchRefSelectorForm = 'canonical',
    namespace?: 'remote',
    // Cancels only this caller's short-name lookups; the shared snapshot read still completes for others.
    signal?: AbortSignal
  ): Promise<RuntimeRepoSearchRefs> {
    if (!isRepoSearchRefsRequestLimit(limit)) {
      throw new Error('invalid_limit')
    }
    const effectiveLimit = clampRepoSearchRefsLimit(limit)
    const probeLimit = getRepoSearchRefsProbeLimit(effectiveLimit)
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return { refs: [], truncated: false }
    }
    const includeQualifiedRefs = selectorForm !== 'unqualified'
    const forClient = async (rows: BaseRefSearchResult[]): Promise<BaseRefSearchResult[]> =>
      selectorForm === 'git-short'
        ? (await import('../../git/refs/resolution/legacy-ref-selectors')).toGitShortRefSelectors(
            repo.path,
            rows,
            signal
          )
        : rows
    if (namespace === 'remote') {
      if (getRepoRoutingConnectionId(repo)) {
        throw new Error('This project is not served by this host.')
      }
      const { searchRemoteRefPage } =
        await import('../../git/refs/resolution/repo-remote-ref-search')
      const page = await searchRemoteRefPage(repo.path, query, effectiveLimit, includeQualifiedRefs)
      const refDetails = await forClient(page.refDetails)
      return { ...page, refDetails, refs: refDetails.map((row) => row.refName), namespace }
    }
    // Unserved SSH hosts report no refs; never search local files for them.
    const refDetails = getRepoRoutingConnectionId(repo)
      ? []
      : await (
          await import('../../git/refs/resolution/repo-base-ref-search')
        ).searchBaseRefDetails(repo.path, query, probeLimit, includeQualifiedRefs)
    const page = await forClient(refDetails.slice(0, effectiveLimit))
    return {
      refs: page.map((entry) => entry.refName),
      refDetails: page,
      // Cap-limited requests are truncated even if the repo has fewer refs than requested.
      truncated: limit > effectiveLimit || refDetails.length > effectiveLimit
    }
  }

  async getDefault(repoSelector: string): Promise<BaseRefDefaultResult> {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return { defaultBaseRef: null, remoteCount: 0 }
    }
    if (getRepoRoutingConnectionId(repo)) {
      return { defaultBaseRef: null, remoteCount: 0 }
    }
    // A client's Settings pane must not start this host's stopped distro over `\\wsl.localhost` (E9).
    const blocked = await blockedWslDistroForPath(repo.path)
    if (blocked) {
      // Optional, so older clients read plain unknown; newer ones re-ask while it is set.
      return { defaultBaseRef: null, remoteCount: 0, refusedWslDistro: blocked.distro }
    }
    const [{ getDefaultBaseRefAsync: getBaseRefDefault }, { getRemoteCount }] = await Promise.all([
      import('../../git/refs/resolution/repo-default-base-ref'),
      import('../../git/remotes/repo-remote-queries')
    ])
    const [defaultBaseRef, remoteCount] = await Promise.all([
      getBaseRefDefault(repo.path),
      getRemoteCount(repo.path)
    ])
    return { defaultBaseRef, remoteCount }
  }
}
