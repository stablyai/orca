import type { Repo } from '../../shared/repo-types'
import type { RuntimeRepoSearchRefs } from '../../shared/runtime-types'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  clampRepoSearchRefsLimit,
  getRepoSearchRefsProbeLimit,
  isRepoSearchRefsRequestLimit
} from '../../shared/repo-search-limits'
import { getBaseRefDefault, getRemoteCount, searchBaseRefDetails } from '../git/repo'
import { getRepoRoutingConnectionId } from '../../shared/execution-host'

type RuntimeRepositoryRefQueryDependencies = {
  resolveRepo: (selector: string) => Promise<Repo>
}

export class RuntimeRepositoryRefQueries {
  constructor(private readonly deps: RuntimeRepositoryRefQueryDependencies) {}

  async search(
    repoSelector: string,
    query: string,
    limit: number,
    includeQualifiedRefs = true
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

  async getDefault(
    repoSelector: string
  ): Promise<{ defaultBaseRef: string | null; remoteCount: number }> {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return { defaultBaseRef: null, remoteCount: 0 }
    }
    if (getRepoRoutingConnectionId(repo)) {
      return { defaultBaseRef: null, remoteCount: 0 }
    }
    const [defaultBaseRef, remoteCount] = await Promise.all([
      getBaseRefDefault(repo.path),
      getRemoteCount(repo.path)
    ])
    return { defaultBaseRef, remoteCount }
  }
}
