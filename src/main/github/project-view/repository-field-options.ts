import {
  acquire,
  extractExecError,
  ghExecFileAsync,
  noteRepositoryRateLimitSpend,
  projectGhExecOptions,
  projectHostAuthenticationError,
  release,
  repositoryRateLimitGuard,
  runGraphql,
  validateSlugArgs
} from './internals'
import { classifyProjectError, rateLimitedError } from './project-error-classification'
import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'
import type {
  ListAssignableUsersBySlugResult,
  ListIssueTypesBySlugResult,
  ListLabelsBySlugResult
} from '../../../shared/github/project-result-types'
import type {
  ListAssignableUsersBySlugArgs,
  ListIssueTypesBySlugArgs,
  ListLabelsBySlugArgs
} from '../../../shared/github/project-request-types'

export async function listLabelsBySlug(
  args: ListLabelsBySlugArgs
): Promise<ListLabelsBySlugResult> {
  const validation = validateSlugArgs(args.owner, args.repo)
  if (!validation.ok) {
    return validation
  }
  const authError = await projectHostAuthenticationError(args.host)
  if (authError) {
    return { ok: false, error: authError }
  }
  const guard = repositoryRateLimitGuard(args, 'core')
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard) }
  }
  await acquire()
  noteRepositoryRateLimitSpend(args, 'core')
  try {
    const { stdout } = await ghExecFileAsync(
      ['api', '--paginate', `repos/${args.owner}/${args.repo}/labels`, '--jq', '.[].name'],
      { encoding: 'utf-8', ...projectGhExecOptions(args.host) }
    )
    return { ok: true, labels: stdout.trim().split('\n').filter(Boolean) }
  } catch (error) {
    const { stderr, stdout } = extractExecError(error)
    return { ok: false, error: classifyProjectError(stderr, stdout, args.host) }
  } finally {
    release()
  }
}

export async function listAssignableUsersBySlug(
  args: ListAssignableUsersBySlugArgs
): Promise<ListAssignableUsersBySlugResult> {
  const validation = validateSlugArgs(args.owner, args.repo)
  if (!validation.ok) {
    return validation
  }
  const authError = await projectHostAuthenticationError(args.host)
  if (authError) {
    return { ok: false, error: authError }
  }
  const guard = repositoryRateLimitGuard(args, 'core')
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard) }
  }
  const users: GitHubAssignableUser[] = []
  await acquire()
  noteRepositoryRateLimitSpend(args, 'core')
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--paginate',
        `repos/${args.owner}/${args.repo}/assignees`,
        '--jq',
        '.[] | {login: .login, name: null, avatarUrl: .avatar_url}'
      ],
      { encoding: 'utf-8', ...projectGhExecOptions(args.host) }
    )
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      try {
        const user = JSON.parse(line) as {
          login?: string
          avatarUrl?: string
          name?: string | null
        }
        if (typeof user.login === 'string') {
          users.push({
            login: user.login,
            name: user.name ?? null,
            avatarUrl: user.avatarUrl ?? ''
          })
        }
      } catch {
        // Skip malformed jq output.
      }
    }
  } catch (error) {
    const { stderr } = extractExecError(error)
    return { ok: false, error: classifyProjectError(stderr, '', args.host) }
  } finally {
    release()
  }
  const seen = new Set(users.map((user) => user.login))
  for (const login of args.seedLogins ?? []) {
    if (typeof login === 'string' && !seen.has(login)) {
      users.push({ login, name: null, avatarUrl: '' })
      seen.add(login)
    }
  }
  return { ok: true, users }
}

export async function listIssueTypesBySlug(
  args: ListIssueTypesBySlugArgs
): Promise<ListIssueTypesBySlugResult> {
  const validation = validateSlugArgs(args.owner, args.repo)
  if (!validation.ok) {
    return validation
  }
  const result = await runGraphql<{
    repository?: {
      issueTypes?: {
        nodes?: ({
          id?: string
          name?: string
          color?: string | null
          description?: string | null
        } | null)[]
      } | null
    } | null
  }>(
    `query($owner:String!, $repo:String!) {
       repository(owner:$owner, name:$repo) {
         issueTypes(first:50) { nodes { id name color description } }
       }
     }`,
    { owner: args.owner, repo: args.repo },
    projectGhExecOptions(args.host)
  )
  if (!result.ok) {
    if (result.error.type === 'schema_drift' || result.error.type === 'validation_error') {
      return { ok: true, types: [] }
    }
    return { ok: false, error: result.error }
  }
  const types = (result.data.repository?.issueTypes?.nodes ?? [])
    .filter(
      (node): node is NonNullable<typeof node> =>
        node !== null && typeof node.id === 'string' && typeof node.name === 'string'
    )
    .map((node) => ({
      id: node.id as string,
      name: node.name as string,
      color: typeof node.color === 'string' ? node.color : null,
      description: typeof node.description === 'string' ? node.description : null
    }))
  return { ok: true, types }
}
