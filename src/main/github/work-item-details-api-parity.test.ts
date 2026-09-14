import { describe, expect, expectTypeOf, it } from 'vitest'
import type { GitHubPRFile, GitHubPRFileContents } from '../../shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../shared/github/work-item-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import type { LocalGitExecOptions } from './gh-utils'
import type { GitHubApiRepository } from './github-api-repository'
import * as workItemDetails from './work-item-details'

type GetWorkItemDetails = (
  repoPath: string,
  number: number,
  type?: 'issue' | 'pr',
  connectionId?: string | null,
  localGitOptions?: LocalGitExecOptions,
  preference?: IssueSourcePreference
) => Promise<GitHubWorkItemDetails | null>

type GetPRFileContents = (args: {
  repoPath: string
  connectionId?: string | null
  localGitOptions?: LocalGitExecOptions
  prRepo?: GitHubApiRepository | null
  prNumber: number
  path: string
  oldPath?: string
  status: GitHubPRFile['status']
  headSha: string
  baseSha: string
}) => Promise<GitHubPRFileContents>

describe('work-item-details public API parity', () => {
  it('retains only the established runtime exports and call signatures', () => {
    expect(Object.keys(workItemDetails).sort()).toEqual(['getPRFileContents', 'getWorkItemDetails'])
    expectTypeOf(workItemDetails.getWorkItemDetails).toEqualTypeOf<GetWorkItemDetails>()
    expectTypeOf(workItemDetails.getPRFileContents).toEqualTypeOf<GetPRFileContents>()
  })
})
