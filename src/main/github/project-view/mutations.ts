import {
  acquire,
  assertPositiveInt,
  extractExecError,
  ghExecFileAsync,
  noteRepositoryRateLimitSpend,
  projectGhExecOptions,
  projectHostAuthenticationError,
  release,
  repositoryRateLimitGuard,
  runRest,
  validateSlugArgs
} from './internals'
import { classifyProjectError, rateLimitedError } from './project-error-classification'
import type { GitHubProjectMutationResult } from '../../../shared/github/project-result-types'
import type { UpdateIssueBySlugArgs } from '../../../shared/github/project-request-types'

export async function updateIssueBySlug(
  args: UpdateIssueBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const validation = validateSlugArgs(args.owner, args.repo)
  if (!validation.ok) {
    return validation
  }
  const number = assertPositiveInt(args.number, 'number')
  if (!number.ok) {
    return { ok: false, error: number.error }
  }
  if (!args.updates || typeof args.updates !== 'object') {
    return { ok: false, error: { type: 'validation_error', message: 'Updates required.' } }
  }
  const duplicateError = validateDuplicateUpdate(args)
  if (duplicateError) {
    return duplicateError
  }
  const authError = await projectHostAuthenticationError(args.host)
  if (authError) {
    return { ok: false, error: authError }
  }
  const base = `repos/${args.owner}/${args.repo}/issues/${args.number}`
  const stateResult = await updateIssueState(args)
  if (!stateResult.ok) {
    return stateResult
  }
  const { title, body } = args.updates
  if (title !== undefined || body !== undefined) {
    const patchArgs = ['-X', 'PATCH', base]
    if (title !== undefined) {
      patchArgs.push('--raw-field', `title=${title}`)
    }
    if (body !== undefined) {
      patchArgs.push('--raw-field', `body=${body}`)
    }
    const result = await runRest<unknown>(
      patchArgs,
      undefined,
      'core',
      projectGhExecOptions(args.host)
    )
    if (!result.ok) {
      return { ok: false, error: result.error }
    }
  }
  const labelResult = await updateIssueLabels(args, base)
  if (!labelResult.ok) {
    return labelResult
  }
  return updateIssueAssignees(args, base)
}

function validateDuplicateUpdate(args: UpdateIssueBySlugArgs): GitHubProjectMutationResult | null {
  const { duplicateOf, state, stateReason } = args.updates
  if (duplicateOf !== undefined && (state !== 'closed' || stateReason !== 'duplicate')) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: 'Duplicate target is only valid when closing as duplicate.'
      }
    }
  }
  if (state === 'closed' && stateReason === 'duplicate' && duplicateOf === undefined) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: 'Duplicate target issue number is required.'
      }
    }
  }
  if (duplicateOf !== undefined) {
    const duplicate = assertPositiveInt(duplicateOf, 'duplicateOf')
    if (!duplicate.ok) {
      return { ok: false, error: duplicate.error }
    }
  }
  return null
}

async function updateIssueState(args: UpdateIssueBySlugArgs): Promise<GitHubProjectMutationResult> {
  const { state, stateReason, duplicateOf } = args.updates
  if (state === undefined) {
    return { ok: true }
  }
  const guard = repositoryRateLimitGuard(args, 'core')
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard) }
  }
  const stateArgs =
    state === 'closed'
      ? ['issue', 'close', String(args.number), '--repo', `${args.owner}/${args.repo}`]
      : ['issue', 'reopen', String(args.number), '--repo', `${args.owner}/${args.repo}`]
  if (state === 'closed') {
    if (stateReason === 'completed') {
      stateArgs.push('--reason', 'completed')
    } else if (stateReason === 'not_planned') {
      stateArgs.push('--reason', 'not planned')
    } else if (stateReason === 'duplicate') {
      stateArgs.push('--duplicate-of', String(duplicateOf))
    }
  }
  await acquire()
  noteRepositoryRateLimitSpend(args, 'core')
  try {
    await ghExecFileAsync(stateArgs, {
      encoding: 'utf-8',
      ...projectGhExecOptions(args.host)
    })
    return { ok: true }
  } catch (error) {
    const { stderr, stdout } = extractExecError(error)
    return { ok: false, error: classifyProjectError(stderr, stdout, args.host) }
  } finally {
    release()
  }
}

async function updateIssueLabels(
  args: UpdateIssueBySlugArgs,
  base: string
): Promise<GitHubProjectMutationResult> {
  const { addLabels = [], removeLabels = [] } = args.updates
  const options = projectGhExecOptions(args.host)
  if (removeLabels.length > 1) {
    const fetched = await runRest<{ name?: string }[]>(
      ['-X', 'GET', `${base}/labels`],
      undefined,
      'core',
      options
    )
    if (!fetched.ok) {
      return { ok: false, error: fetched.error }
    }
    const names = new Set(
      fetched.data.map((label) => label.name).filter((name): name is string => Boolean(name))
    )
    for (const label of removeLabels) {
      names.delete(label)
    }
    for (const label of addLabels) {
      names.add(label)
    }
    if (names.size === 0) {
      const result = await runRest<unknown>(['-X', 'DELETE', `${base}/labels`], undefined, 'core', {
        expectEmpty: true,
        ...options
      })
      return result.ok || result.error.type === 'not_found'
        ? { ok: true }
        : { ok: false, error: result.error }
    }
    const putArgs = ['-X', 'PUT', `${base}/labels`]
    for (const name of names) {
      putArgs.push('--raw-field', `labels[]=${name}`)
    }
    const result = await runRest<unknown>(putArgs, undefined, 'core', options)
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  }
  if (addLabels.length > 0) {
    const postArgs = ['-X', 'POST', `${base}/labels`]
    for (const label of addLabels) {
      postArgs.push('--raw-field', `labels[]=${label}`)
    }
    const result = await runRest<unknown>(postArgs, undefined, 'core', options)
    if (!result.ok) {
      return { ok: false, error: result.error }
    }
  }
  if (removeLabels.length === 1) {
    const result = await runRest<unknown>(
      ['-X', 'DELETE', `${base}/labels/${encodeURIComponent(removeLabels[0])}`],
      undefined,
      'core',
      { expectEmpty: true, ...options }
    )
    if (!result.ok && result.error.type !== 'not_found') {
      return { ok: false, error: result.error }
    }
  }
  return { ok: true }
}

async function updateIssueAssignees(
  args: UpdateIssueBySlugArgs,
  base: string
): Promise<GitHubProjectMutationResult> {
  const { addAssignees = [], removeAssignees = [] } = args.updates
  const options = projectGhExecOptions(args.host)
  if (addAssignees.length > 0) {
    const postArgs = ['-X', 'POST', `${base}/assignees`]
    for (const login of addAssignees) {
      postArgs.push('--raw-field', `assignees[]=${login}`)
    }
    const result = await runRest<unknown>(postArgs, undefined, 'core', options)
    if (!result.ok) {
      return { ok: false, error: result.error }
    }
  }
  if (removeAssignees.length > 0) {
    const deleteArgs = ['-X', 'DELETE', `${base}/assignees`]
    for (const login of removeAssignees) {
      deleteArgs.push('--raw-field', `assignees[]=${login}`)
    }
    const result = await runRest<unknown>(deleteArgs, undefined, 'core', options)
    if (!result.ok) {
      return { ok: false, error: result.error }
    }
  }
  return { ok: true }
}
