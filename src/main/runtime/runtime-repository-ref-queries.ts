import type { Repo } from '../../shared/repo-types'
import type { RuntimeRepoSearchRefs } from '../../shared/runtime-types'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  clampRepoSearchRefsLimit,
  getRepoSearchRefsProbeLimit,
  isRepoSearchRefsRequestLimit
} from '../../shared/repo-search-limits'
import { getBaseRefDefault, getRemoteCount, searchBaseRefDetails } from '../git/repo'

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
    // Why: an `ssh:` repo is not served here; it reports no refs and never searches this machine.
    const refDetails = repo.connectionId
      ? []
      : await searchBaseRefDetails(repo.path, query, probeLimit, includeQualifiedRefs)
    return {
      refs: refDetails.slice(0, effectiveLimit).map((entry) => entry.refName),
      refDetails: refDetails.slice(0, effectiveLimit),
      // An oversized request is intentionally reported as truncated even when
      // this repo has fewer refs: the execution cap prevented fulfilling the
      // requested page size.
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
    if (repo.connectionId) {
      return { defaultBaseRef: null, remoteCount: 0 }
    }
    const [defaultBaseRef, remoteCount] = await Promise.all([
      getBaseRefDefault(repo.path),
      getRemoteCount(repo.path)
    ])
    return { defaultBaseRef, remoteCount }
  }
}
