/* eslint-disable max-lines -- Why: the PR/Issue details service groups the
   body/comments/files/checks fetch paths alongside the file-contents resolver
   so the drawer's rate-limit and caching strategy lives in one place. */
import type {
  GitHubAssignableUser,
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubWorkItem,
  GitHubWorkItemDetails,
  PRComment
} from '../../shared/types'
import { ghExecFileAsync, acquire, release, getOwnerRepo, getIssueOwnerRepo } from './gh-utils'
import { getWorkItem, getPRChecks, getPRComments } from './client'

// Why: a PR "changed file" listing returned by the REST endpoint is paginated
// at 100 per page; we cap at a reasonable total so a massive PR cannot starve
// the gh semaphore while we fetch file listings.
const MAX_PR_FILES = 300

const WORK_ITEM_PARTICIPANTS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $isPr: Boolean!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) @include(if: $isPr) {
      participants(first: 100) {
        nodes { login avatarUrl(size: 48) ... on User { name } }
      }
    }
    issue(number: $number) @skip(if: $isPr) {
      participants(first: 100) {
        nodes { login avatarUrl(size: 48) ... on User { name } }
      }
    }
  }
}`

// Why: a single GraphQL round-trip replaces three serial gh subprocesses on
// the issue path (REST issue + REST comments + GraphQL participants). The
// previous fan-out could spawn ~3 `gh` processes per drawer-open; this drops
// it to one. We still fall back to the legacy REST+GraphQL path if the
// collapsed query throws or returns missing data — see the strict-fallback
// branch in getWorkItemDetails.
const ISSUE_DETAILS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      body
      assignees(first: 50) { nodes { login } }
      participants(first: 100) {
        nodes { login avatarUrl(size: 48) ... on User { name } }
      }
      comments(first: 100) {
        nodes {
          databaseId
          body
          createdAt
          url
          author {
            login
            avatarUrl(size: 48)
            ... on Bot { __typename }
          }
        }
      }
    }
  }
}`

type GraphQLIssueDetailsResponse = {
  data?: {
    repository?: {
      issue?: {
        body?: string | null
        assignees?: { nodes?: { login?: string }[] }
        participants?: { nodes?: GitHubAssignableUser[] }
        comments?: {
          nodes?: {
            databaseId?: number | null
            body?: string | null
            createdAt?: string | null
            url?: string | null
            author?: {
              login?: string | null
              avatarUrl?: string | null
              __typename?: string
            } | null
          }[]
        }
      } | null
    } | null
  }
  errors?: { message?: string }[]
}

async function getIssueDetailsViaGraphQL(
  repoPath: string,
  issueNumber: number
): Promise<{
  body: string
  comments: PRComment[]
  assignees: string[]
  participants: GitHubAssignableUser[]
} | null> {
  const ownerRepo = await getIssueOwnerRepo(repoPath)
  if (!ownerRepo) {
    return null
  }
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        'graphql',
        '-f',
        `query=${ISSUE_DETAILS_QUERY}`,
        '-f',
        `owner=${ownerRepo.owner}`,
        '-f',
        `repo=${ownerRepo.repo}`,
        '-F',
        `number=${issueNumber}`
      ],
      { cwd: repoPath }
    )
    const parsed = JSON.parse(stdout) as GraphQLIssueDetailsResponse
    if (parsed.errors && parsed.errors.length > 0) {
      // Why: any partial GraphQL error (permissions, unknown field on a fork)
      // forces the strict REST fallback so the drawer never paints a half-built
      // shell. The fallback path's behavior is the historical contract.
      return null
    }
    const issue = parsed.data?.repository?.issue
    if (!issue) {
      return null
    }
    const comments: PRComment[] = (issue.comments?.nodes ?? [])
      .filter((c) => typeof c.databaseId === 'number')
      .map((c) => ({
        id: c.databaseId as number,
        author: c.author?.login ?? 'ghost',
        authorAvatarUrl: c.author?.avatarUrl ?? '',
        body: c.body ?? '',
        createdAt: c.createdAt ?? '',
        url: c.url ?? '',
        isBot: c.author?.__typename === 'Bot'
      }))
    const assignees = (issue.assignees?.nodes ?? [])
      .map((a) => a.login)
      .filter((login): login is string => Boolean(login))
    const participants: GitHubAssignableUser[] = (issue.participants?.nodes ?? [])
      .filter((u) => Boolean(u.login))
      .map((u) => ({
        login: u.login,
        name: u.name ?? null,
        avatarUrl: u.avatarUrl ?? ''
      }))
    return {
      body: issue.body ?? '',
      comments,
      assignees,
      participants
    }
  } catch {
    return null
  }
}

function mergeGitHubUsers(users: GitHubAssignableUser[]): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  for (const user of users) {
    if (!user.login) {
      continue
    }
    const key = user.login.toLowerCase()
    const existing = byLogin.get(key)
    if (existing) {
      // Why: avoid mutating caller-provided objects — return a new merged record
      // so upstream references to `user`/`existing` stay unchanged.
      byLogin.set(key, {
        login: existing.login,
        name: existing.name ?? user.name ?? null,
        avatarUrl: existing.avatarUrl || user.avatarUrl || ''
      })
      continue
    }
    byLogin.set(key, {
      login: user.login,
      name: user.name ?? null,
      avatarUrl: user.avatarUrl ?? ''
    })
  }
  return Array.from(byLogin.values())
}

type RESTPRFile = {
  filename: string
  previous_filename?: string
  status: string
  additions: number
  deletions: number
  changes: number
  /** Raw patch text when available; absent for binary files or patches over GitHub's size cap. */
  patch?: string
}

function mapFileStatus(raw: string): GitHubPRFile['status'] {
  switch (raw) {
    case 'added':
      return 'added'
    case 'removed':
      return 'removed'
    case 'modified':
      return 'modified'
    case 'renamed':
      return 'renamed'
    case 'copied':
      return 'copied'
    case 'changed':
      return 'changed'
    case 'unchanged':
      return 'unchanged'
    default:
      return 'modified'
  }
}

// Why: GitHub's REST file listing does not explicitly flag binary files, but it
// omits the `patch` field for them. When a file has changes but no patch, we
// treat it as binary so the drawer's diff tab can show a placeholder instead of
// attempting to fetch contents that would render as noise in a text diff viewer.
function isBinaryHint(file: RESTPRFile): boolean {
  if (file.status === 'removed' || file.status === 'added') {
    // A newly added or removed file with zero patch text but non-zero changes
    // is almost always binary (images, lockfiles over the size cap, etc.).
    return file.patch === undefined && file.changes > 0
  }
  return file.patch === undefined && file.changes > 0
}

async function getPRHeadBaseSha(
  repoPath: string,
  prNumber: number
): Promise<{ headSha: string; baseSha: string } | null> {
  const ownerRepo = await getOwnerRepo(repoPath)
  try {
    if (ownerRepo) {
      const { stdout } = await ghExecFileAsync(
        ['api', '--cache', '60s', `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}`],
        { cwd: repoPath }
      )
      const data = JSON.parse(stdout) as {
        head?: { sha?: string }
        base?: { sha?: string }
      }
      if (data.head?.sha && data.base?.sha) {
        return { headSha: data.head.sha, baseSha: data.base.sha }
      }
      return null
    }
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', String(prNumber), '--json', 'headRefOid,baseRefOid'],
      { cwd: repoPath }
    )
    const data = JSON.parse(stdout) as { headRefOid?: string; baseRefOid?: string }
    if (data.headRefOid && data.baseRefOid) {
      return { headSha: data.headRefOid, baseSha: data.baseRefOid }
    }
    return null
  } catch {
    return null
  }
}

async function getPRFiles(repoPath: string, prNumber: number): Promise<GitHubPRFile[]> {
  const ownerRepo = await getOwnerRepo(repoPath)
  if (!ownerRepo) {
    return []
  }
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--cache',
        '60s',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}/files?per_page=100`
      ],
      { cwd: repoPath }
    )
    const data = JSON.parse(stdout) as RESTPRFile[]
    return data.slice(0, MAX_PR_FILES).map((file) => ({
      path: file.filename,
      oldPath: file.previous_filename,
      status: mapFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
      isBinary: isBinaryHint(file)
    }))
  } catch {
    return []
  }
}

async function getIssueBodyAndComments(
  repoPath: string,
  issueNumber: number
): Promise<{ body: string; comments: PRComment[]; assignees: string[] }> {
  const ownerRepo = await getIssueOwnerRepo(repoPath)
  try {
    if (ownerRepo) {
      const [issueResult, commentsResult] = await Promise.all([
        ghExecFileAsync(
          [
            'api',
            '--cache',
            '60s',
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}`
          ],
          { cwd: repoPath }
        ),
        ghExecFileAsync(
          [
            'api',
            '--cache',
            '60s',
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}/comments?per_page=100`
          ],
          { cwd: repoPath }
        )
      ])
      const issue = JSON.parse(issueResult.stdout) as {
        body?: string | null
        assignees?: { login: string }[]
      }
      type RESTComment = {
        id: number
        user: { login: string; avatar_url: string; type?: string } | null
        body: string
        created_at: string
        html_url: string
      }
      const comments = (JSON.parse(commentsResult.stdout) as RESTComment[]).map(
        (c): PRComment => ({
          id: c.id,
          author: c.user?.login ?? 'ghost',
          authorAvatarUrl: c.user?.avatar_url ?? '',
          body: c.body ?? '',
          createdAt: c.created_at,
          url: c.html_url,
          isBot: c.user?.type === 'Bot'
        })
      )
      const assignees = (issue.assignees ?? []).map((a) => a.login)
      return { body: issue.body ?? '', comments, assignees }
    }
    // Fallback: non-GitHub remote
    const { stdout } = await ghExecFileAsync(
      ['issue', 'view', String(issueNumber), '--json', 'body,comments,assignees'],
      { cwd: repoPath }
    )
    const data = JSON.parse(stdout) as {
      body?: string
      comments?: {
        author: { login: string }
        body: string
        createdAt: string
        url: string
      }[]
      assignees?: { login: string }[]
    }
    const comments = (data.comments ?? []).map(
      (c, i): PRComment => ({
        id: i,
        author: c.author?.login ?? 'ghost',
        authorAvatarUrl: '',
        body: c.body ?? '',
        createdAt: c.createdAt,
        url: c.url ?? ''
      })
    )
    const fallbackAssignees = (data.assignees ?? []).map((a) => a.login)
    return { body: data.body ?? '', comments, assignees: fallbackAssignees }
  } catch {
    return { body: '', comments: [], assignees: [] }
  }
}

async function getPRBody(repoPath: string, prNumber: number): Promise<string> {
  const ownerRepo = await getOwnerRepo(repoPath)
  try {
    if (ownerRepo) {
      const { stdout } = await ghExecFileAsync(
        ['api', '--cache', '60s', `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}`],
        { cwd: repoPath }
      )
      const data = JSON.parse(stdout) as { body?: string | null }
      return data.body ?? ''
    }
    const { stdout } = await ghExecFileAsync(['pr', 'view', String(prNumber), '--json', 'body'], {
      cwd: repoPath
    })
    const data = JSON.parse(stdout) as { body?: string }
    return data.body ?? ''
  } catch {
    return ''
  }
}

async function getWorkItemParticipants(
  repoPath: string,
  item: Pick<GitHubWorkItem, 'number' | 'type'>
): Promise<GitHubAssignableUser[]> {
  // Why: issues in a fork live on the upstream remote, so participants must be
  // resolved via getIssueOwnerRepo to stay consistent with getIssueBodyAndComments.
  // PRs remain tied to origin via getOwnerRepo.
  const ownerRepo =
    item.type === 'issue' ? await getIssueOwnerRepo(repoPath) : await getOwnerRepo(repoPath)
  if (!ownerRepo) {
    return []
  }
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        'graphql',
        '-f',
        `query=${WORK_ITEM_PARTICIPANTS_QUERY}`,
        '-f',
        `owner=${ownerRepo.owner}`,
        '-f',
        `repo=${ownerRepo.repo}`,
        '-F',
        `number=${item.number}`,
        '-F',
        `isPr=${item.type === 'pr'}`
      ],
      { cwd: repoPath }
    )
    const data = JSON.parse(stdout) as {
      data?: {
        repository?: {
          pullRequest?: {
            participants?: { nodes?: GitHubAssignableUser[] }
          } | null
          issue?: {
            participants?: { nodes?: GitHubAssignableUser[] }
          } | null
        }
      }
    }
    const nodes =
      data.data?.repository?.pullRequest?.participants?.nodes ??
      data.data?.repository?.issue?.participants?.nodes ??
      []
    return nodes
      .map((user) => ({
        login: user.login,
        name: user.name ?? null,
        avatarUrl: user.avatarUrl ?? ''
      }))
      .filter((user) => user.login)
  } catch {
    return []
  }
}

async function getGitHubUsersByLogin(
  repoPath: string,
  logins: string[]
): Promise<GitHubAssignableUser[]> {
  const uniqueLogins = Array.from(
    new Set(logins.filter((login) => login && login !== 'ghost').map((login) => login.trim()))
  ).slice(0, 40)
  if (uniqueLogins.length === 0) {
    return []
  }
  const fields = uniqueLogins
    .map(
      (login, index) =>
        `u${index}: user(login: ${JSON.stringify(login)}) { login name avatarUrl(size: 48) }`
    )
    .join('\n')
  try {
    const { stdout } = await ghExecFileAsync(
      ['api', 'graphql', '-f', `query=query { ${fields} }`],
      {
        cwd: repoPath
      }
    )
    const data = JSON.parse(stdout) as {
      data?: Record<
        string,
        { login?: string; name?: string | null; avatarUrl?: string | null } | null
      >
    }
    return Object.values(data.data ?? {})
      .filter((user): user is { login: string; name?: string | null; avatarUrl?: string | null } =>
        Boolean(user?.login)
      )
      .map((user) => ({
        login: user.login,
        name: user.name ?? null,
        avatarUrl: user.avatarUrl ?? ''
      }))
  } catch {
    return []
  }
}

async function getMentionParticipants(
  repoPath: string,
  item: Pick<GitHubWorkItem, 'author' | 'number' | 'type'>,
  comments: PRComment[],
  participants: GitHubAssignableUser[]
): Promise<GitHubAssignableUser[]> {
  const visibleLogins = [item.author ?? '', ...comments.map((comment) => comment.author)]
  // Why: one aliased GraphQL query returns login/name/avatarUrl for every
  // mentioned author in a single round-trip. The previous REST fan-out
  // (/users/<login>) returned the same fields but cost one rate-limit point
  // per user.
  const graphQlUsers = await getGitHubUsersByLogin(repoPath, visibleLogins)
  return mergeGitHubUsers([...participants, ...graphQlUsers])
}

export async function getWorkItemDetails(
  repoPath: string,
  number: number,
  type?: 'issue' | 'pr'
): Promise<GitHubWorkItemDetails | null> {
  // Why: getWorkItem already handles acquire/release. We call it first (outside
  // our semaphore) so the known-cheap lookup doesn't compete with the richer
  // detail fetches that follow.
  const item: Omit<GitHubWorkItem, 'repoId'> | null = await getWorkItem(repoPath, number, type)
  if (!item) {
    return null
  }

  await acquire()
  try {
    if (item.type === 'issue') {
      // Why: try the collapsed single-GraphQL path first — body, assignees,
      // participants, and comments all return in one round-trip. On any
      // failure (permissions, partial errors, non-GitHub remote), strictly
      // fall back to the legacy REST+GraphQL fan-out so historical behavior
      // is preserved. The GraphQL `participants` connection includes every
      // commenter, so we skip the extra `getMentionParticipants` aliased
      // user-hydration trip when the collapsed path succeeds.
      const collapsed = await getIssueDetailsViaGraphQL(repoPath, item.number)
      if (collapsed) {
        return {
          item,
          body: collapsed.body,
          comments: collapsed.comments,
          assignees: collapsed.assignees,
          participants: collapsed.participants
        }
      }
      // Why: fall back to body/comments and GraphQL participants in parallel;
      // the mention-participant merge is a cheap local operation afterward.
      const [{ body, comments, assignees }, participants] = await Promise.all([
        getIssueBodyAndComments(repoPath, item.number),
        getWorkItemParticipants(repoPath, item)
      ])
      const mentionParticipants = await getMentionParticipants(
        repoPath,
        item,
        comments,
        participants
      )
      return { item, body, comments, assignees, participants: mentionParticipants }
    }

    // PR: fetch body + comments + checks + files + head/base SHAs in parallel.
    const [body, comments, shas, files, participants] = await Promise.all([
      getPRBody(repoPath, item.number),
      getPRComments(repoPath, item.number),
      getPRHeadBaseSha(repoPath, item.number),
      getPRFiles(repoPath, item.number),
      getWorkItemParticipants(repoPath, item)
    ])

    // Why: run the mention-author GraphQL lookup in parallel with the final
    // checks fetch instead of serially — both depend only on data from the
    // Promise.all above, so there's no ordering requirement between them.
    const [mentionParticipants, checks] = await Promise.all([
      getMentionParticipants(repoPath, item, comments, participants),
      shas?.headSha
        ? getPRChecks(repoPath, item.number, shas.headSha)
        : getPRChecks(repoPath, item.number)
    ])

    return {
      item,
      body,
      comments,
      headSha: shas?.headSha,
      baseSha: shas?.baseSha,
      checks,
      files,
      participants: mentionParticipants
    }
  } finally {
    release()
  }
}

// Why: base64-decoded contents at specific commits are needed to feed Orca's
// Monaco-based DiffViewer (which expects original/modified text, not unified
// diff patches). Fetching via gh api --cache keeps rate-limit usage bounded
// during rapid file-expand clicks in the drawer.
async function fetchContentAtRef(args: {
  repoPath: string
  owner: string
  repo: string
  path: string
  ref: string
}): Promise<{ content: string; isBinary: boolean }> {
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--cache',
        '300s',
        '-H',
        'Accept: application/vnd.github.raw',
        `repos/${args.owner}/${args.repo}/contents/${encodeURI(args.path)}?ref=${encodeURIComponent(args.ref)}`
      ],
      { cwd: args.repoPath }
    )
    // Raw content response: Electron's execFile returns string in utf-8. If the
    // file is binary, the string will contain replacement characters — we treat
    // anything with a NUL byte in the first 2KB as binary and skip rendering.
    const sample = stdout.slice(0, 2048)
    if (sample.includes('\u0000')) {
      return { content: '', isBinary: true }
    }
    return { content: stdout, isBinary: false }
  } catch {
    return { content: '', isBinary: false }
  }
}

export async function getPRFileContents(args: {
  repoPath: string
  prNumber: number
  path: string
  oldPath?: string
  status: GitHubPRFile['status']
  headSha: string
  baseSha: string
}): Promise<GitHubPRFileContents> {
  const ownerRepo = await getOwnerRepo(args.repoPath)
  if (!ownerRepo) {
    return {
      original: '',
      modified: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }

  await acquire()
  try {
    // Why: for added files there's no original content at the base ref; for
    // removed files there's no modified content at the head ref. Skipping the
    // redundant fetches keeps latency down and avoids spurious 404 warnings.
    const needsOriginal = args.status !== 'added'
    const needsModified = args.status !== 'removed'
    const originalRef = args.baseSha
    const originalPath = args.oldPath ?? args.path

    const [original, modified] = await Promise.all([
      needsOriginal
        ? fetchContentAtRef({
            repoPath: args.repoPath,
            owner: ownerRepo.owner,
            repo: ownerRepo.repo,
            path: originalPath,
            ref: originalRef
          })
        : Promise.resolve({ content: '', isBinary: false }),
      needsModified
        ? fetchContentAtRef({
            repoPath: args.repoPath,
            owner: ownerRepo.owner,
            repo: ownerRepo.repo,
            path: args.path,
            ref: args.headSha
          })
        : Promise.resolve({ content: '', isBinary: false })
    ])

    return {
      original: original.content,
      modified: modified.content,
      originalIsBinary: original.isBinary,
      modifiedIsBinary: modified.isBinary
    }
  } finally {
    release()
  }
}
