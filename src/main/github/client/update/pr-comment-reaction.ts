import type { GitHubReactionContent } from '../../../../shared/github/comment-types'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { toGraphQLReactionContent } from '../../comment-reactions'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
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
