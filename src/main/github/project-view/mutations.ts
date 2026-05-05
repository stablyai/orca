/* eslint-disable max-lines -- Why: slug-addressed mutations + work-item
details share the validate/runRest/runGraphql plumbing with the read path.
Keeping them together preserves a single review surface for the write side. */
import {
  acquire,
  release,
  extractExecError,
  ghExecFileAsync,
  rateLimitGuard,
  noteRateLimitSpend,
  classifyProjectError,
  rateLimitedError,
  runGraphql,
  runRest,
  validateSlugArgs,
  assertPositiveInt,
  type GraphqlVars
} from './internals'
import type { GitHubAssignableUser, GitHubWorkItemDetails, PRComment } from '../../../shared/types'
import type {
  AddIssueCommentBySlugArgs,
  ClearProjectItemFieldArgs,
  DeleteIssueCommentBySlugArgs,
  GitHubProjectCommentMutationResult,
  GitHubProjectFieldMutationValue,
  GitHubProjectMutationResult,
  ListAssignableUsersBySlugArgs,
  ListAssignableUsersBySlugResult,
  ListIssueTypesBySlugArgs,
  ListIssueTypesBySlugResult,
  ListLabelsBySlugArgs,
  ListLabelsBySlugResult,
  ProjectWorkItemDetailsBySlugArgs,
  ProjectWorkItemDetailsBySlugResult,
  UpdateIssueBySlugArgs,
  UpdateIssueCommentBySlugArgs,
  UpdateIssueTypeBySlugArgs,
  UpdatePullRequestBySlugArgs,
  UpdateProjectItemFieldArgs
} from '../../../shared/github-project-types'

// ─── Project field mutations ──────────────────────────────────────────

class UnknownFieldMutationKindError extends Error {
  constructor(kind: string) {
    super(`Unknown project field mutation kind: ${kind}`)
  }
}

function graphqlValueForFieldMutation(value: GitHubProjectFieldMutationValue): string {
  // Serialize the value fragment for the GraphQL mutation. We use GraphQL
  // variables for every dynamic piece, so here we only pick the variable name
  // to reference per value kind.
  switch (value.kind) {
    case 'single-select':
      return 'singleSelectOptionId: $value'
    case 'iteration':
      return 'iterationId: $value'
    case 'text':
      return 'text: $value'
    case 'number':
      return 'number: $value'
    case 'date':
      return 'date: $value'
    default:
      // Why: defensive default. If a new mutation kind is added to the type
      // but not handled here, returning undefined would silently produce a
      // broken GraphQL query. Throw so updateProjectItemFieldValue can map it
      // to a validation_error rather than dispatching a malformed mutation.
      throw new UnknownFieldMutationKindError((value as { kind: string }).kind)
  }
}

function mutationValueVar(value: GitHubProjectFieldMutationValue): {
  type: string
  val: string | number
} {
  switch (value.kind) {
    case 'single-select':
      return { type: 'String!', val: value.optionId }
    case 'iteration':
      return { type: 'String!', val: value.iterationId }
    case 'text':
      return { type: 'String!', val: value.text }
    case 'number':
      return { type: 'Float!', val: value.number }
    case 'date':
      return { type: 'Date!', val: value.date }
    default:
      // Why: see graphqlValueForFieldMutation — surface unknown kinds loudly
      // instead of returning undefined and dispatching an invalid mutation.
      throw new UnknownFieldMutationKindError((value as { kind: string }).kind)
  }
}

export async function updateProjectItemFieldValue(
  args: UpdateProjectItemFieldArgs
): Promise<GitHubProjectMutationResult> {
  if (!args.projectId || !args.itemId || !args.fieldId) {
    return { ok: false, error: { type: 'validation_error', message: 'Missing ids.' } }
  }
  let valFrag: string
  let valVar: { type: string; val: string | number }
  try {
    valFrag = graphqlValueForFieldMutation(args.value)
    valVar = mutationValueVar(args.value)
  } catch (err) {
    if (err instanceof UnknownFieldMutationKindError) {
      return { ok: false, error: { type: 'validation_error', message: err.message } }
    }
    throw err
  }
  const query = `
    mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $value:${valVar.type}) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { ${valFrag} }
      }) { projectV2Item { id } }
    }
  `
  const vars: GraphqlVars = {
    projectId: args.projectId,
    itemId: args.itemId,
    fieldId: args.fieldId,
    value: valVar.val
  }
  const res = await runGraphql<unknown>(query, vars)
  if (!res.ok) {return { ok: false, error: res.error }}
  return { ok: true }
}

export async function clearProjectItemFieldValue(
  args: ClearProjectItemFieldArgs
): Promise<GitHubProjectMutationResult> {
  if (!args.projectId || !args.itemId || !args.fieldId) {
    return { ok: false, error: { type: 'validation_error', message: 'Missing ids.' } }
  }
  const query = `
    mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!) {
      clearProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
      }) { projectV2Item { id } }
    }
  `
  const res = await runGraphql<unknown>(query, {
    projectId: args.projectId,
    itemId: args.itemId,
    fieldId: args.fieldId
  })
  if (!res.ok) {return { ok: false, error: res.error }}
  return { ok: true }
}

// ─── Slug-addressed issue/PR mutations ────────────────────────────────

export async function updateIssueBySlug(
  args: UpdateIssueBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {return v}
  const n = assertPositiveInt(args.number, 'number')
  if (!n.ok) {return { ok: false, error: n.error }}
  if (!args.updates || typeof args.updates !== 'object') {
    return { ok: false, error: { type: 'validation_error', message: 'Updates required.' } }
  }
  const { title, body, state, addLabels, removeLabels, addAssignees, removeAssignees } = args.updates

  // Title / body / state go through PATCH /repos/{owner}/{repo}/issues/{n}.
  // Labels/assignees go through their dedicated endpoints.
  const base = `repos/${args.owner}/${args.repo}/issues/${args.number}`

  // 1) PATCH body
  if (title !== undefined || body !== undefined || state !== undefined) {
    const patchArgs: string[] = ['-X', 'PATCH', base]
    if (title !== undefined) {patchArgs.push('--raw-field', `title=${title}`)}
    if (body !== undefined) {patchArgs.push('--raw-field', `body=${body}`)}
    if (state !== undefined) {patchArgs.push('--raw-field', `state=${state}`)}
    const r = await runRest<unknown>(patchArgs)
    if (!r.ok) {return { ok: false, error: r.error }}
  }

  // 2) Labels — collapse multi-delete fan-out into a single PUT when removing
  //    >1 label. PUT /labels replaces the entire label set, so we fetch the
  //    current labels first and compute the resulting set client-side. This
  //    turns an N-delete + 1-add (=N+1 calls) into 1-fetch + 1-PUT (=2 calls)
  //    once removeLabels has more than one entry, capping the cost at 2 even
  //    for a "remove all 20 labels" mutation.
  const removeCount = removeLabels?.length ?? 0
  const addCount = addLabels?.length ?? 0
  if (removeCount > 1) {
    type RawLabelResp = { name?: string }[]
    const fetched = await runRest<RawLabelResp>(['-X', 'GET', `${base}/labels`])
    if (!fetched.ok) {return { ok: false, error: fetched.error }}
    const currentNames = new Set(
      fetched.data.map((l) => l.name).filter((n): n is string => typeof n === 'string')
    )
    for (const l of removeLabels ?? []) {currentNames.delete(l)}
    for (const l of addLabels ?? []) {currentNames.add(l)}
    if (currentNames.size === 0) {
      // Why: `gh api -X PUT` with no `--raw-field` arguments sends an empty
      // body — GitHub does NOT interpret that as "clear labels". The
      // dedicated DELETE endpoint is the documented way to remove all
      // labels in a single call.
      const r = await runRest<unknown>(
        ['-X', 'DELETE', `${base}/labels`],
        undefined,
        'core',
        { expectEmpty: true }
      )
      if (!r.ok && r.error.type !== 'not_found') {return { ok: false, error: r.error }}
    } else {
      const putArgs = ['-X', 'PUT', `${base}/labels`]
      for (const name of currentNames) {putArgs.push('--raw-field', `labels[]=${name}`)}
      const r = await runRest<unknown>(putArgs)
      if (!r.ok) {return { ok: false, error: r.error }}
    }
  } else {
    if (addCount > 0) {
      const restArgs = ['-X', 'POST', `${base}/labels`]
      for (const l of addLabels ?? []) {restArgs.push('--raw-field', `labels[]=${l}`)}
      const r = await runRest<unknown>(restArgs)
      if (!r.ok) {return { ok: false, error: r.error }}
    }
    if (removeCount === 1) {
      const r = await runRest<unknown>(
        ['-X', 'DELETE', `${base}/labels/${encodeURIComponent(removeLabels![0])}`],
        undefined,
        'core',
        { expectEmpty: true }
      )
      if (!r.ok && r.error.type !== 'not_found') {return { ok: false, error: r.error }}
    }
  }

  // 3) Assignees — POST and DELETE both accept arrays in a single call, so
  //    add/remove are at most 2 calls regardless of array size.
  if (addAssignees && addAssignees.length > 0) {
    const restArgs = ['-X', 'POST', `${base}/assignees`]
    for (const u of addAssignees) {restArgs.push('--raw-field', `assignees[]=${u}`)}
    const r = await runRest<unknown>(restArgs)
    if (!r.ok) {return { ok: false, error: r.error }}
  }
  if (removeAssignees && removeAssignees.length > 0) {
    const restArgs = ['-X', 'DELETE', `${base}/assignees`]
    for (const u of removeAssignees) {restArgs.push('--raw-field', `assignees[]=${u}`)}
    const r = await runRest<unknown>(restArgs)
    if (!r.ok) {return { ok: false, error: r.error }}
  }
  return { ok: true }
}

export async function updatePullRequestBySlug(
  args: UpdatePullRequestBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {return v}
  const n = assertPositiveInt(args.number, 'number')
  if (!n.ok) {return { ok: false, error: n.error }}
  if (!args.updates || typeof args.updates !== 'object') {
    return { ok: false, error: { type: 'validation_error', message: 'Updates required.' } }
  }
  const patchArgs: string[] = ['-X', 'PATCH', `repos/${args.owner}/${args.repo}/pulls/${args.number}`]
  // Why: count fields explicitly rather than inferring from patchArgs.length —
  // adding a future header/flag arg silently breaks an array-length check.
  let fieldCount = 0
  if (args.updates.title !== undefined) {
    patchArgs.push('--raw-field', `title=${args.updates.title}`)
    fieldCount++
  }
  if (args.updates.body !== undefined) {
    patchArgs.push('--raw-field', `body=${args.updates.body}`)
    fieldCount++
  }
  if (fieldCount === 0) {
    // No fields to update — nothing to do.
    return { ok: true }
  }
  const r = await runRest<unknown>(patchArgs)
  if (!r.ok) {return { ok: false, error: r.error }}
  return { ok: true }
}

type RawIssueCommentResponse = {
  id?: number
  user?: { login?: string; avatar_url?: string; type?: string } | null
  body?: string
  created_at?: string
  html_url?: string
}

function mapIssueComment(data: RawIssueCommentResponse, fallbackBody: string): PRComment {
  return {
    id: data.id ?? Date.now(),
    author: data.user?.login ?? 'You',
    authorAvatarUrl: data.user?.avatar_url ?? '',
    body: data.body ?? fallbackBody,
    createdAt: data.created_at ?? new Date().toISOString(),
    url: data.html_url ?? '',
    isBot: data.user?.type === 'Bot'
  }
}

export async function addIssueCommentBySlug(
  args: AddIssueCommentBySlugArgs
): Promise<GitHubProjectCommentMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {return v}
  const n = assertPositiveInt(args.number, 'number')
  if (!n.ok) {return { ok: false, error: n.error }}
  if (typeof args.body !== 'string' || !args.body.trim()) {
    return { ok: false, error: { type: 'validation_error', message: 'Comment body required.' } }
  }
  const r = await runRest<RawIssueCommentResponse>([
    '-X',
    'POST',
    `repos/${args.owner}/${args.repo}/issues/${args.number}/comments`,
    '--raw-field',
    `body=${args.body}`
  ])
  if (!r.ok) {return { ok: false, error: r.error }}
  return { ok: true, comment: mapIssueComment(r.data, args.body) }
}

export async function updateIssueCommentBySlug(
  args: UpdateIssueCommentBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {return v}
  const n = assertPositiveInt(args.commentId, 'commentId')
  if (!n.ok) {return { ok: false, error: n.error }}
  if (typeof args.body !== 'string' || !args.body.trim()) {
    return { ok: false, error: { type: 'validation_error', message: 'Comment body required.' } }
  }
  const r = await runRest<unknown>([
    '-X',
    'PATCH',
    `repos/${args.owner}/${args.repo}/issues/comments/${args.commentId}`,
    '--raw-field',
    `body=${args.body}`
  ])
  if (!r.ok) {return { ok: false, error: r.error }}
  return { ok: true }
}

export async function deleteIssueCommentBySlug(
  args: DeleteIssueCommentBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {return v}
  const n = assertPositiveInt(args.commentId, 'commentId')
  if (!n.ok) {return { ok: false, error: n.error }}
  const r = await runRest<unknown>(
    ['-X', 'DELETE', `repos/${args.owner}/${args.repo}/issues/comments/${args.commentId}`],
    undefined,
    'core',
    { expectEmpty: true }
  )
  if (!r.ok) {return { ok: false, error: r.error }}
  return { ok: true }
}

// ─── Slug-addressed picker sources ────────────────────────────────────

export async function listLabelsBySlug(
  args: ListLabelsBySlugArgs
): Promise<ListLabelsBySlugResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {return v}
  const guard = rateLimitGuard('core')
  if (guard.blocked) {return { ok: false, error: rateLimitedError(guard) }}
  await acquire()
  // Why: `--paginate` may fan out to multiple pages; we can only reasonably
  // estimate a 1-call spend up front. The next probe will reconcile.
  noteRateLimitSpend('core')
  try {
    const { stdout } = await ghExecFileAsync(
      ['api', '--paginate', `repos/${args.owner}/${args.repo}/labels`, '--jq', '.[].name'],
      { encoding: 'utf-8' }
    )
    return {
      ok: true,
      labels: stdout
        .trim()
        .split('\n')
        .filter((l) => l.length > 0)
    }
  } catch (err) {
    const { stderr, stdout: maybeStdout } = extractExecError(err)
    return { ok: false, error: classifyProjectError(stderr, maybeStdout) }
  } finally {
    release()
  }
}

export async function listAssignableUsersBySlug(
  args: ListAssignableUsersBySlugArgs
): Promise<ListAssignableUsersBySlugResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {return v}
  // Seed logins merge after the fetch so callers can include currently-visible
  // assignees even if the repo participant search is sparse.
  const result: GitHubAssignableUser[] = []
  const guard = rateLimitGuard('core')
  if (guard.blocked) {return { ok: false, error: rateLimitedError(guard) }}
  await acquire()
  noteRateLimitSpend('core')
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--paginate',
        `repos/${args.owner}/${args.repo}/assignees`,
        '--jq',
        '.[] | {login: .login, name: null, avatarUrl: .avatar_url}'
      ],
      { encoding: 'utf-8' }
    )
    for (const line of stdout.trim().split('\n').filter((l) => l.length > 0)) {
      try {
        const u = JSON.parse(line) as { login?: string; avatarUrl?: string; name?: string | null }
        if (typeof u.login === 'string') {
          result.push({ login: u.login, name: u.name ?? null, avatarUrl: u.avatarUrl ?? '' })
        }
      } catch {
        // skip malformed jq line
      }
    }
  } catch (err) {
    const { stderr } = extractExecError(err)
    return { ok: false, error: classifyProjectError(stderr, '') }
  } finally {
    release()
  }
  if (args.seedLogins) {
    const seen = new Set(result.map((u) => u.login))
    for (const login of args.seedLogins) {
      if (typeof login === 'string' && !seen.has(login)) {
        result.push({ login, name: null, avatarUrl: '' })
        seen.add(login)
      }
    }
  }
  return { ok: true, users: result }
}

// Why: Issue Types are a repo-level taxonomy (Bug/Feature/Task/etc) only
// available on repos opted into typed-issues. Empty list (or schema_drift on
// older GitHub deployments) is the legitimate "this repo doesn't use issue
// types" signal — callers should treat it as "no editor".
export async function listIssueTypesBySlug(
  args: ListIssueTypesBySlugArgs
): Promise<ListIssueTypesBySlugResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {return v}
  const query = `
    query($owner:String!, $repo:String!) {
      repository(owner:$owner, name:$repo) {
        issueTypes(first:50) {
          nodes { id name color description }
        }
      }
    }
  `
  const res = await runGraphql<{
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
  }>(query, { owner: args.owner, repo: args.repo })
  if (!res.ok) {
    // Why: repos without issue types respond with a GraphQL error claiming the
    // `issueTypes` field is unknown. Map that to an empty list so the UI shows
    // "no editor" instead of an angry banner.
    if (res.error.type === 'schema_drift' || res.error.type === 'validation_error') {
      return { ok: true, types: [] }
    }
    return { ok: false, error: res.error }
  }
  const nodes = res.data.repository?.issueTypes?.nodes ?? []
  const types = nodes
    .filter((n): n is NonNullable<typeof n> => n !== null && typeof n.id === 'string' && typeof n.name === 'string')
    .map((n) => ({
      id: n.id as string,
      name: n.name as string,
      color: typeof n.color === 'string' ? n.color : null,
      description: typeof n.description === 'string' ? n.description : null
    }))
  return { ok: true, types }
}

export async function updateIssueTypeBySlug(
  args: UpdateIssueTypeBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {return v}
  const n = assertPositiveInt(args.number, 'number')
  if (!n.ok) {return { ok: false, error: n.error }}
  // Why: `updateIssueIssueType` is the dedicated mutation; passing null for
  // `issueTypeId` clears the type. We resolve the issue id via a lightweight
  // GraphQL lookup because the REST endpoint doesn't accept issue types.
  const lookup = await runGraphql<{
    repository?: { issue?: { id?: string } | null } | null
  }>(
    `query($owner:String!, $repo:String!, $num:Int!) {
       repository(owner:$owner, name:$repo) { issue(number:$num) { id } }
     }`,
    { owner: args.owner, repo: args.repo, num: args.number }
  )
  if (!lookup.ok) {return { ok: false, error: lookup.error }}
  const issueId = lookup.data.repository?.issue?.id
  if (!issueId) {
    return { ok: false, error: { type: 'not_found', message: 'Issue not found.' } }
  }
  // Why: build the mutation conditionally so a null clear doesn't have to
  // smuggle a null GraphQL variable through `gh api graphql -f`. The
  // mutation accepts a literal `null` in the input object directly.
  const query = args.issueTypeId
    ? `
        mutation($issueId:ID!, $issueTypeId:ID!) {
          updateIssueIssueType(input: { issueId: $issueId, issueTypeId: $issueTypeId }) {
            issue { id }
          }
        }
      `
    : `
        mutation($issueId:ID!) {
          updateIssueIssueType(input: { issueId: $issueId, issueTypeId: null }) {
            issue { id }
          }
        }
      `
  const vars: GraphqlVars = args.issueTypeId
    ? { issueId, issueTypeId: args.issueTypeId }
    : { issueId }
  const res = await runGraphql<unknown>(query, vars)
  if (!res.ok) {return { ok: false, error: res.error }}
  return { ok: true }
}

// ─── Slug-addressed work-item details ─────────────────────────────────

type RawUser = { login?: string; name?: string | null; avatarUrl?: string | null }
type RawLabel = { name?: string; color?: string }
type RawWorkItemContent = {
  id?: string
  number?: number
  title?: string
  url?: string
  state?: string
  stateReason?: string | null
  isDraft?: boolean
  labels?: { nodes?: RawLabel[] }
  assignees?: { nodes?: RawUser[] }
}

export async function getWorkItemDetailsBySlug(
  args: ProjectWorkItemDetailsBySlugArgs
): Promise<ProjectWorkItemDetailsBySlugResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {return v}
  const n = assertPositiveInt(args.number, 'number')
  if (!n.ok) {return { ok: false, error: n.error }}
  if (args.type !== 'issue' && args.type !== 'pr') {
    return { ok: false, error: { type: 'validation_error', message: 'Invalid type.' } }
  }

  // Single GraphQL round-trip to fetch the issue/PR summary + comments + labels + assignees.
  const contentFrag =
    args.type === 'issue'
      ? `
        issue(number:$num) {
          id number title url state stateReason updatedAt
          body
          author { login }
          labels(first:50) { nodes { name } }
          assignees(first:50) { nodes { login } }
          participants(first:50) { nodes { login name avatarUrl } }
          comments(first:100) {
            nodes {
              databaseId
              author { login avatarUrl __typename }
              body createdAt url
            }
          }
        }
      `
      : `
        pullRequest(number:$num) {
          id number title url state isDraft updatedAt headRefName baseRefName
          body
          author { login }
          labels(first:50) { nodes { name } }
          assignees(first:50) { nodes { login } }
          participants(first:50) { nodes { login name avatarUrl } }
          comments(first:100) {
            nodes {
              databaseId
              author { login avatarUrl __typename }
              body createdAt url
            }
          }
        }
      `
  const query = `
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        ${contentFrag}
      }
    }
  `
  const res = await runGraphql<{
    repository?: {
      issue?: RawWorkItemContent & {
        updatedAt?: string
        body?: string
        author?: { login?: string } | null
        participants?: { nodes?: RawUser[] }
        comments?: {
          nodes?: ({
            databaseId?: number
            author?: { login?: string; avatarUrl?: string; __typename?: string } | null
            body?: string
            createdAt?: string
            url?: string
          } | null)[]
        }
      } | null
      pullRequest?: RawWorkItemContent & {
        updatedAt?: string
        body?: string
        headRefName?: string
        baseRefName?: string
        author?: { login?: string } | null
        participants?: { nodes?: RawUser[] }
        comments?: {
          nodes?: ({
            databaseId?: number
            author?: { login?: string; avatarUrl?: string; __typename?: string } | null
            body?: string
            createdAt?: string
            url?: string
          } | null)[]
        }
      } | null
    } | null
  }>(query, { owner: args.owner, repo: args.repo, num: args.number })
  if (!res.ok) {return { ok: false, error: res.error }}
  const raw = args.type === 'issue' ? res.data.repository?.issue : res.data.repository?.pullRequest
  if (!raw) {
    return { ok: false, error: { type: 'not_found', message: 'Item not found.' } }
  }

  const labels = (raw.labels?.nodes ?? [])
    .map((l) => l?.name)
    .filter((n): n is string => typeof n === 'string')
  const assignees = (raw.assignees?.nodes ?? [])
    .map((a) => a?.login)
    .filter((l): l is string => typeof l === 'string')
  const comments: PRComment[] = []
  for (const c of raw.comments?.nodes ?? []) {
    if (!c || typeof c.body !== 'string') {continue}
    comments.push({
      id: typeof c.databaseId === 'number' ? c.databaseId : Date.now(),
      author: c.author?.login ?? '',
      authorAvatarUrl: c.author?.avatarUrl ?? '',
      body: c.body,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
      url: typeof c.url === 'string' ? c.url : '',
      isBot: c.author?.__typename === 'Bot'
    })
  }
  const participants: GitHubAssignableUser[] = []
  for (const p of raw.participants?.nodes ?? []) {
    if (p && typeof p.login === 'string') {
      participants.push({ login: p.login, name: p.name ?? null, avatarUrl: p.avatarUrl ?? '' })
    }
  }

  const state: 'open' | 'closed' | 'merged' | 'draft' =
    args.type === 'pr'
      ? raw.isDraft
        ? 'draft'
        : raw.state === 'MERGED'
          ? 'merged'
          : raw.state === 'CLOSED'
            ? 'closed'
            : 'open'
      : raw.state === 'CLOSED'
        ? 'closed'
        : 'open'

  const details: GitHubWorkItemDetails = {
    item: {
      id: typeof raw.id === 'string' ? raw.id : '',
      type: args.type,
      number: typeof raw.number === 'number' ? raw.number : args.number,
      title: typeof raw.title === 'string' ? raw.title : '',
      state,
      url: typeof raw.url === 'string' ? raw.url : '',
      labels,
      updatedAt:
        typeof (raw as { updatedAt?: string }).updatedAt === 'string'
          ? (raw as { updatedAt: string }).updatedAt
          : '',
      author:
        typeof (raw as { author?: { login?: string } | null }).author?.login === 'string'
          ? ((raw as { author: { login: string } }).author.login as string)
          : null,
      branchName:
        args.type === 'pr' && typeof (raw as { headRefName?: string }).headRefName === 'string'
          ? ((raw as { headRefName: string }).headRefName as string)
          : undefined,
      baseRefName:
        args.type === 'pr' && typeof (raw as { baseRefName?: string }).baseRefName === 'string'
          ? ((raw as { baseRefName: string }).baseRefName as string)
          : undefined
    },
    body: typeof raw.body === 'string' ? raw.body : '',
    comments,
    participants,
    // Why: PR files/checks/review-thread tabs depend on a local repo path and
    // are out of Project-mode slug scope for v1. Omit them here; the dialog
    // branches on their absence and hides those tabs.
    ...(args.type === 'issue' ? { assignees } : {})
  }
  return { ok: true, details }
}

