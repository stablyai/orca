import type { BaseRefDefaultResult, Repo } from '../../../shared/repo-types'
import type { RuntimeRepoSearchRefs } from '../../../shared/runtime-worktree-contracts'
import { isFolderRepo } from '../../../shared/repo-kind'
import {
  clampRepoSearchRefsLimit,
  getRepoSearchRefsProbeLimit,
  isRepoSearchRefsRequestLimit
} from '../../../shared/repo-search-limits'
import { getDefaultBaseRefAsync as getBaseRefDefault } from '../../git/refs/resolution/repo-default-base-ref'
import { getRemoteCount } from '../../git/remotes/repo-remote-queries'
import { searchRemoteRefPage } from '../../git/refs/resolution/repo-remote-ref-search'
import { searchBaseRefDetails } from '../../git/refs/resolution/repo-base-ref-search'
import { getRepoRoutingConnectionId } from '../../../shared/execution-host'
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
    includeQualifiedRefs = true,
    namespace?: 'remote'
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
    if (namespace === 'remote') {
      if (getRepoRoutingConnectionId(repo)) {
        throw new Error('This project is not served by this host.')
      }
      const page = await searchRemoteRefPage(repo.path, query, effectiveLimit, includeQualifiedRefs)
      return { ...page, refs: page.refDetails.map((row) => row.refName), namespace }
    }
    // Unserved SSH hosts report no refs; never search local files for them.
    const refDetails = getRepoRoutingConnectionId(repo)
      ? []
      : await searchBaseRefDetails(repo.path, query, probeLimit, includeQualifiedRefs)
    return {
      refs: refDetails.slice(0, effectiveLimit).map((entry) => entry.refName),
      refDetails: refDetails.slice(0, effectiveLimit),
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
    const [defaultBaseRef, remoteCount] = await Promise.all([
      getBaseRefDefault(repo.path),
      getRemoteCount(repo.path)
    ])
    return { defaultBaseRef, remoteCount }
  }
}
