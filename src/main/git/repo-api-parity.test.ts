import { describe, expect, it } from 'vitest'
import * as repo from './repo'

describe('repo public API parity', () => {
  it('keeps the historical runtime export surface', () => {
    expect(Object.keys(repo).sort()).toEqual(
      [
        'DEFAULT_BASE_REF_PROBES',
        'buildSearchBaseRefsArgv',
        'getBaseRefDefault',
        'getBranchConflictKind',
        'getDefaultBaseRef',
        'getDefaultRemote',
        'getGitRepoRoot',
        'getLinkedWorktreeMainRepoRoot',
        'getRecentDriftSubjects',
        'getRemoteCommitUrl',
        'getRemoteCount',
        'getRemoteDrift',
        'getRemoteFileUrl',
        'getRemoteUrl',
        'getRepoName',
        'isForEachRefExcludeUnsupportedError',
        'isGitRepo',
        'mergeBaseRefSearchResultGroups',
        'normalizeGitRepoRootForInputPath',
        'normalizeRefSearchQuery',
        'parseAndFilterSearchRefDetails',
        'parseRemoteCount',
        'resolveDefaultBaseRefViaExec',
        'resolveDefaultBaseRefWithLocalGit',
        'searchBaseRefDetails',
        'searchBaseRefs'
      ].sort()
    )
  })
})
