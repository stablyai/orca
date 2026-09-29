import {
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type { RuntimeRepoSearchRefs } from '../../../../shared/runtime-worktree-contracts'

function isNamespaceQualifiedRef(refName: string): boolean {
  return refName.startsWith('refs/heads/') || refName.startsWith('refs/remotes/')
}

export function projectRepoSearchRefsForClient(
  result: RuntimeRepoSearchRefs,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): RuntimeRepoSearchRefs {
  // Undefined is an in-process caller. Authenticated remote clients always
  // provide an array, with old clients represented by an empty capability set.
  if (
    clientCapabilities === undefined ||
    clientCapabilities.includes(REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY)
  ) {
    return result
  }
  // Fail closed for legacy refs-only clients. A qualified selector is emitted
  // only when Git's short spelling is corrupt or ambiguous, and projecting it
  // as an ordinary branch would make those clients create/reuse the wrong ref.
  return {
    ...result,
    refs: result.refs.filter((refName) => !isNamespaceQualifiedRef(refName)),
    ...(result.refDetails
      ? {
          refDetails: result.refDetails.filter(({ refName }) => !isNamespaceQualifiedRef(refName))
        }
      : {})
  }
}
