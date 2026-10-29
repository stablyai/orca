import {
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type { RuntimeRepoSearchRefs } from '../../../../shared/runtime-worktree-contracts'

import { isQualifiedBaseRef } from '../../../git/base-ref-search-selector'

export function includesQualifiedSearchRefs(
  clientCapabilities: readonly RuntimeCapability[] | undefined
): boolean {
  return (
    clientCapabilities === undefined ||
    clientCapabilities.includes(REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY)
  )
}

export function projectRepoSearchRefsForClient(
  result: RuntimeRepoSearchRefs,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): RuntimeRepoSearchRefs {
  // In-process callers have no capability array; legacy remote clients have an empty one.
  if (includesQualifiedSearchRefs(clientCapabilities)) {
    return result
  }
  // Legacy clients could mistake a qualified selector for an ordinary branch name.
  return {
    ...result,
    refs: result.refs.filter((refName) => !isQualifiedBaseRef(refName)),
    ...(result.refDetails
      ? {
          refDetails: result.refDetails.filter(({ refName }) => !isQualifiedBaseRef(refName))
        }
      : {})
  }
}
