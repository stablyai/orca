import { assertPositiveInt, projectGhExecOptions, runRest, validateSlugArgs } from './internals'
import type { GitHubProjectMutationResult } from '../../../shared/github/project-result-types'
import type { UpdatePullRequestBySlugArgs } from '../../../shared/github/project-request-types'

export async function updatePullRequestBySlug(
  args: UpdatePullRequestBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const slug = validateSlugArgs(args.owner, args.repo)
  if (!slug.ok) {
    return slug
  }
  const number = assertPositiveInt(args.number, 'number')
  if (!number.ok) {
    return { ok: false, error: number.error }
  }
  if (!args.updates || typeof args.updates !== 'object') {
    return { ok: false, error: { type: 'validation_error', message: 'Updates required.' } }
  }
  const patchArgs: string[] = [
    '-X',
    'PATCH',
    `repos/${args.owner}/${args.repo}/pulls/${args.number}`
  ]
  let fieldCount = 0
  if (args.updates.title !== undefined) {
    patchArgs.push('--raw-field', `title=${args.updates.title}`)
    fieldCount++
  }
  if (args.updates.body !== undefined) {
    patchArgs.push('--raw-field', `body=${args.updates.body}`)
    fieldCount++
  }
  if (args.updates.state !== undefined) {
    patchArgs.push('--raw-field', `state=${args.updates.state}`)
    fieldCount++
  }
  if (fieldCount === 0) {
    return { ok: true }
  }
  const result = await runRest<unknown>(
    patchArgs,
    undefined,
    'core',
    projectGhExecOptions(args.host)
  )
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}
