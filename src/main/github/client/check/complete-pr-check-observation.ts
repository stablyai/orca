import type { GitHubApiRepository } from '../../github-api-repository'
import type { GhExecOptions } from '../github-exec-scope'
import { assertRateLimitBudget } from '../lookup/pr-lookup-rate-limit'
import { readGraphQLPRCheckRollup } from './pr-check-rollup'
import { readRestPRCheckRollup } from './rest-pr-check-pages'

export async function readCompletePRCheckObservation(
  repository: GitHubApiRepository,
  number: number,
  headSha: string | undefined,
  options: GhExecOptions
): Promise<unknown[] | undefined> {
  if (!headSha) {
    return undefined
  }
  try {
    await assertRateLimitBudget('graphql', repository, options)
    return await readGraphQLPRCheckRollup(repository, number, headSha, options)
  } catch {
    try {
      return await readRestPRCheckRollup(repository, headSha, options)
    } catch {
      return undefined
    }
  }
}
