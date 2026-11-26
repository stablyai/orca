import '../../../../../shared/remote-runtime/protocol/protocol-version'
import {
  REPO_SEARCH_CANONICAL_REFS_RUNTIME_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY
} from '../../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import type { RuntimeCapability } from '../../../../../shared/remote-runtime/protocol/protocol-version'
import type { RuntimeRepoSearchRefs } from '../../../../../shared/worktree/catalog/runtime-worktree-contracts'

import { isQualifiedBaseRef } from '../../../../git/refs/resolution/base-ref-search-selector'
import type { RepoSearchRefSelectorForm } from '../../../../git/refs/resolution/legacy-ref-selectors'

export function repoSearchRefSelectorForm(
  clientCapabilities: readonly RuntimeCapability[] | undefined
): RepoSearchRefSelectorForm {
  if (
    clientCapabilities === undefined ||
    clientCapabilities.includes(REPO_SEARCH_CANONICAL_REFS_RUNTIME_CAPABILITY)
  ) {
    return 'canonical'
  }
  return clientCapabilities.includes(REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY)
    ? 'git-short'
    : 'unqualified'
}

export function projectRepoSearchRefsForClient(
  result: RuntimeRepoSearchRefs,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): RuntimeRepoSearchRefs {
  // In-process callers have no capability array; legacy remote clients have an empty one.
  if (repoSearchRefSelectorForm(clientCapabilities) !== 'unqualified') {
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
