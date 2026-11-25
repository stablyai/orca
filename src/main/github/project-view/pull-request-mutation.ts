import { githubBodyImageUrls, githubBodyMediaHeaders } from '../attachments/body-image-urls'
import { assertPositiveInt, validateSlugArgs } from './project-argument-validation'
import { projectGhExecOptions } from './project-host-execution'
import { runRest } from './project-rest'
import type { GitHubProjectMutationResult } from '../../../shared/github/projects/project-result-types'
import type { UpdatePullRequestBySlugArgs } from '../../../shared/github/projects/project-request-types'

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
    return {
      ok: false,
      error: { type: 'validation_error', message: 'Updates required.', reason: 'updates_required' }
    }
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
    patchArgs.push(
      ...githubBodyMediaHeaders(args.updates.body),
      '--raw-field',
      `body=${args.updates.body}`
    )
    fieldCount++
  }
  if (args.updates.state !== undefined) {
    patchArgs.push('--raw-field', `state=${args.updates.state}`)
    fieldCount++
  }
  if (fieldCount === 0) {
    return { ok: true }
  }
  const result = await runRest<{ body?: string; body_html?: string }>(
    patchArgs,
    undefined,
    'core',
    projectGhExecOptions(args.host)
  )
  return result.ok
    ? {
        ok: true,
        bodyImageUrls:
          args.updates.body !== undefined
            ? githubBodyImageUrls(result.data?.body ?? args.updates.body, result.data?.body_html)
            : undefined
      }
    : { ok: false, error: result.error }
}
