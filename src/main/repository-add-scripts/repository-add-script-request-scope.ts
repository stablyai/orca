import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  RepositoryAddScriptPreview,
  RepositoryAddScriptRequest
} from '../../shared/repository-add-script-types'
import type { NewGitRepositoryObserver } from './new-git-repository-observer'

export type RepositoryAddScriptCollectorSource = {
  createRepositoryAddScriptCollector: (hostId: ExecutionHostId) => {
    onNewGitRepository: NewGitRepositoryObserver
    previews: () => RepositoryAddScriptPreview[]
  }
}

export type RepositoryAddScriptRequestScope = {
  // Undefined without an opt-in, so a legacy request never reaches the add-script service.
  observer: NewGitRepositoryObserver | undefined
  // Result fields to spread; empty when nothing was offered, never an undefined key.
  singleFields: () => { repositoryAddScriptPreview?: RepositoryAddScriptPreview }
  manyFields: () => { repositoryAddScriptPreviews?: RepositoryAddScriptPreview[] }
}

const NO_OPT_IN: RepositoryAddScriptRequestScope = {
  observer: undefined,
  singleFields: () => ({}),
  manyFields: () => ({})
}

/** One registration request's collector; call it inside the handler, never at registration time. */
export function openRepositoryAddScriptRequestScope(
  source: RepositoryAddScriptCollectorSource,
  request: RepositoryAddScriptRequest | undefined
): RepositoryAddScriptRequestScope {
  if (!request) {
    return NO_OPT_IN
  }
  const collector = source.createRepositoryAddScriptCollector(request.hostId)
  return {
    observer: collector.onNewGitRepository,
    singleFields: () => {
      const [preview] = collector.previews()
      return preview ? { repositoryAddScriptPreview: preview } : {}
    },
    manyFields: () => {
      const previews = collector.previews()
      return previews.length > 0 ? { repositoryAddScriptPreviews: previews } : {}
    }
  }
}
