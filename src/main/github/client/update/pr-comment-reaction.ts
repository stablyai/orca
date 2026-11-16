import type { GitHubReactionContent } from '../../../../shared/github/comments/comment-types'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { acquire, release } from '../../execution/github-operation-slots'
import type { LocalGitExecOptions } from '../../repositories/github-repository-identity'
import { resolveGitHubRepoExecution } from '../../repositories/github-api-repository'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import { toGraphQLReactionContent } from '../../comments/comment-reactions'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../api/rate-limit'
export async function setPRCommentReaction(
  repoPath: string,
  reactionSubjectId: string,
  content: GitHubReactionContent,
  reacted: boolean,
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<boolean> {
  const mutation = reacted ? 'addReaction' : 'removeReaction'
  const query = `mutation($subjectId: ID!, $content: ReactionContent!) {
    ${mutation}(input: { subjectId: $subjectId, content: $content }) {
      subject { id }
    }
  }`
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return false
  }
  const guard = repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions)
  if (guard.blocked) {
    console.warn(
      `${mutation} skipped: GitHub GraphQL rate limit nearly exhausted (${guard.remaining}/${guard.limit})`
    )
    return false
  }
  await acquire()
  try {
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    await ghExecFileAsync(
      [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `subjectId=${reactionSubjectId}`,
        '-f',
        `content=${toGraphQLReactionContent(content)}`
      ],
      ghOptions
    )
    return true
  } catch (err) {
    console.warn(`${mutation} failed:`, err)
    return false
  } finally {
    release()
  }
}
