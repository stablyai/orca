import { defineMethod } from '../../core'
import { FileSearch } from '../../../../../shared/rpc-contract/filesystem/files-params'
import { limitSearchResultToContentBudget } from '../../../../../shared/file-search/search-result-transport-budget'
import { remoteFileContentBudget } from './files-remote-content-budget'
import { claimMobileFileSearch } from './files-mobile-search-supersession'

export const FILE_SEARCH_METHODS = [
  defineMethod({
    name: 'files.search',
    permission: 'workspace',
    params: FileSearch,
    handler: async (
      params,
      { runtime, clientKind, requestId, signal, pairedDeviceId, clientId }
    ) => {
      const phoneSearch =
        clientKind === 'mobile' ? claimMobileFileSearch(pairedDeviceId ?? clientId, signal) : null
      try {
        return limitSearchResultToContentBudget(
          await runtime.searchRuntimeFiles(
            params.worktree,
            {
              query: params.query,
              caseSensitive: params.caseSensitive,
              wholeWord: params.wholeWord,
              useRegex: params.useRegex,
              includePattern: params.includePattern,
              excludePattern: params.excludePattern,
              maxResults: params.maxResults
            },
            { signal: phoneSearch?.signal ?? signal }
          ),
          remoteFileContentBudget(clientKind, requestId)
        )
      } finally {
        phoneSearch?.release()
      }
    }
  })
]
