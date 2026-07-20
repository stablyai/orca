/* eslint-disable max-lines -- Why: groups the PR/Issue fetch paths and file-contents resolver so caching/rate-limit strategy lives in one place. */
import type {
  GitHubAssignableUser,
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubPRFileViewedState,
  GitHubIssueTimelineItem,
  GitHubIssueTimelineTarget,
  GitHubWorkItem,
  GitHubWorkItemDetails,
  PRCheckDetail,
  PRComment
} from '../../shared/types'
import {
  ghExecFileAsync,
  acquire,
  release,
  getOwnerRepo,
  getIssueOwnerRepo,
  ghRepoExecOptions,
  githubRepoContext,
  type LocalGitExecOptions
} from './gh-utils'
import { getWorkItem, getPRChecks, getPRComments } from './client'
import { noteRateLimitSpend, rateLimitGuard } from './rate-limit'
import { getPRReviewCommentLineNumbersFromPatch } from './pr-review-comment-lines'
import { isMaxBufferOverflowError } from '../git/max-buffer-overflow'

// Why: cap total PR files so a massive PR can't starve the gh semaphore while paging (100/page).
const MAX_PR_FILES = 300
// Why: bound noisy issue timelines so one huge issue can't monopolize gh/API time.
const MAX_ISSUE_TIMELINE_ITEMS = 300
const GITHUB_REST_PAGE_SIZE = 100
// Why: raw-fetch buffer must exceed the renderer's large-diff threshold, else the UI shows an empty diff instead of the fallback.
const GITHUB_RAW_CONTENT_MAX_BUFFER_BYTES = 8 * 1024 * 1024

function localGitOptionArgs(options: LocalGitExecOptions = {}): [] | [LocalGitExecOptions] {
  return Object.keys(options).length > 0 ? [options] : []
}

const PR_FILE_VIEWED_STATES_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          path
          viewerViewedState
        }
      }
    }
  }
}`

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

// Why: one GraphQL round-trip replaces the 3 serial gh subprocesses (REST issue + comments + participants); falls back to the legacy path on failure.
const ISSUE_DETAILS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      body
      assignees(first: 50) { nodes { login avatarUrl(size: 48) ... on User { name } } }
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
        assignees?: { nodes?: { login?: string; avatarUrl?: string; name?: string | null }[] }
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

type GitHubOwnerRepoSlug = { owner: string; repo: string }

type RestTimelineUser = {
  login?: string | null
  avatar_url?: string | null
}

type RestTimelineIssue = {
  number?: number | null
  title?: string | null
  html_url?: string | null
  repository?: {
    name?: string | null
    owner?: { login?: string | null } | null
  } | null
  pull_request?: unknown
}

type RestTimelineEvent = {
  id?: number | string | null
  node_id?: string | null
  event?: string | null
  actor?: RestTimelineUser | null
  user?: RestTimelineUser | null
  assignee?: RestTimelineUser | null
  created_at?: string | null
  source?: {
    issue?: RestTimelineIssue | null
  } | null
  closer?: RestTimelineIssue | null
  state_reason?: string | null
  project_card?: {
    column_name?: string | null
    previous_column_name?: string | null
    project_url?: string | null
  } | null
  project?: {
    name?: string | null
  } | null
  project_column_name?: string | null
  previous_column_name?: string | null
}

function isSupportedTimelineEvent(
  eventName: string | null | undefined
): eventName is GitHubIssueTimelineItem['event'] {
  return (
    eventName === 'assigned' ||
    eventName === 'unassigned' ||
    eventName === 'mentioned' ||
    eventName === 'cross-referenced' ||
    eventName === 'closed' ||
    eventName === 'reopened' ||
    eventName === 'moved_columns_in_project'
  )
}

function mapTimelineTarget(
  issue: RestTimelineIssue | null | undefined
): GitHubIssueTimelineTarget | undefined {
  if (!issue || typeof issue.number !== 'number' || !issue.html_url) {
    return undefined
  }
  const owner = issue.repository?.owner?.login
  const repo = issue.repository?.name
  return {
    type: issue.pull_request ? 'pr' : 'issue',
    number: issue.number,
    title: issue.title ?? '',
    url: issue.html_url,
    repository: owner && repo ? `${owner}/${repo}` : undefined
  }
}

function getTimelineActor(event: RestTimelineEvent): { login: string; avatarUrl: string } {
  const actor = event.actor ?? event.user
  return {
    login: actor?.login ?? 'ghost',
    avatarUrl: actor?.avatar_url ?? ''
  }
}

function mapRestTimelineEvent(event: RestTimelineEvent): GitHubIssueTimelineItem | null {
  const eventName = event.event
  if (!isSupportedTimelineEvent(eventName)) {
    return null
  }
  if (!event.created_at) {
    return null
  }
  const actor = getTimelineActor(event)
  const id = String(event.node_id ?? event.id ?? `${eventName}:${event.created_at}`)
  const base = {
    id,
    event: eventName,
    actor: actor.login,
    actorAvatarUrl: actor.avatarUrl,
    createdAt: event.created_at
  }
  if (eventName === 'assigned' || eventName === 'unassigned') {
    return {
      ...base,
      assignee: event.assignee?.login ?? undefined
    }
  }
  if (eventName === 'mentioned' || eventName === 'cross-referenced') {
    return {
      ...base,
      source: mapTimelineTarget(event.source?.issue)
    }
  }
  if (eventName === 'closed') {
    return {
      ...base,
      stateReason: event.state_reason ?? null,
      closer: mapTimelineTarget(event.closer ?? event.source?.issue)
    }
  }
  if (eventName === 'moved_columns_in_project') {
    return {
      ...base,
      previousColumnName:
        event.previous_column_name ?? event.project_card?.previous_column_name ?? null,
      columnName: event.project_column_name ?? event.project_card?.column_name ?? null,
      projectName: event.project?.name ?? null
    }
  }
  return base
}

function parseRestTimelineEventLines(stdout: string): RestTimelineEvent[] {
  const events: RestTimelineEvent[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        events.push(parsed)
      }
    } catch {
      // Skip malformed jq lines; timeline activity is auxiliary to issue details.
    }
  }
  return events
}

async function getIssueTimelineItems(
  ownerRepo: GitHubOwnerRepoSlug,
  issueNumber: number,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<GitHubIssueTimelineItem[]> {
  try {
    const items: GitHubIssueTimelineItem[] = []
    for (let page = 1; items.length < MAX_ISSUE_TIMELINE_ITEMS; page += 1) {
      const { stdout } = await ghExecFileAsync(
        [
          'api',
          '--cache',
          '60s',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}/timeline?per_page=${GITHUB_REST_PAGE_SIZE}&page=${page}`,
          '--jq',
          '.[] | @json'
        ],
        ghOptions
      )
      // Why: --jq emits NDJSON and explicit paging lets us stop once we hit the drawer cap.
      const pageEvents = parseRestTimelineEventLines(stdout)
      for (const event of pageEvents) {
        const item = mapRestTimelineEvent(event)
        if (!item) {
          continue
        }
        items.push(item)
        if (items.length === MAX_ISSUE_TIMELINE_ITEMS) {
          break
        }
      }
      if (pageEvents.length < GITHUB_REST_PAGE_SIZE) {
        break
      }
    }
    return items
  } catch {
    return []
  }
}

/**
 * Fetch an issue's body, comments, assignees, participants, and timeline in one GraphQL round-trip.
 * Returns null on any partial error so the caller falls back to the strict REST path.
 * Avatars are resolved here so GHE users don't render blank.
 */
async function getIssueDetailsViaGraphQL(
  repoPath: string,
  issueNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{
  body: string
  comments: PRComment[]
  assignees: string[]
  // Avatar-bearing assignees, kept separate from the login-only `assignees`; enriches avatars `gh` leaves blank (GHE).
  assigneeUsers: GitHubAssignableUser[]
  participants: GitHubAssignableUser[]
  timelineItems: GitHubIssueTimelineItem[]
} | null> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = await getIssueOwnerRepo(
    repoPath,
    connectionId,
    ...localGitOptionArgs(localGitOptions)
  )
  if (!ownerRepo) {
    return null
  }
  if (rateLimitGuard('graphql').blocked) {
    return null
  }
  try {
    noteRateLimitSpend('graphql')
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
      ghOptions
    )
    const parsed = JSON.parse(stdout) as GraphQLIssueDetailsResponse
    if (parsed.errors && parsed.errors.length > 0) {
      // Why: any partial GraphQL error forces the strict REST fallback so the drawer never paints a half-built shell.
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
    const assigneeUsers: GitHubAssignableUser[] = (issue.assignees?.nodes ?? [])
      .filter((a): a is { login: string; avatarUrl?: string; name?: string | null } =>
        Boolean(a.login)
      )
      .map((a) => ({
        login: a.login,
        name: a.name ?? null,
        avatarUrl: a.avatarUrl ?? ''
      }))
    const assignees = assigneeUsers.map((a) => a.login)
    const participants: GitHubAssignableUser[] = (issue.participants?.nodes ?? [])
      .filter((u) => Boolean(u.login))
      .map((u) => ({
        login: u.login,
        name: u.name ?? null,
        avatarUrl: u.avatarUrl ?? ''
      }))
    const timelineItems = await getIssueTimelineItems(ownerRepo, issueNumber, ghOptions)
    return {
      body: issue.body ?? '',
      comments,
      assignees,
      assigneeUsers,
      participants,
      timelineItems
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
      // Why: return a new merged record instead of mutating caller-provided objects.
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

// Why: REST doesn't flag binaries but omits `patch` for them; treat "changes but no patch" as binary so the diff tab shows a placeholder.
function isBinaryHint(file: RESTPRFile): boolean {
  if (file.status === 'removed' || file.status === 'added') {
    // Added/removed file with changes but no patch is almost always binary (images, oversized lockfiles).
    return file.patch === undefined && file.changes > 0
  }
  return file.patch === undefined && file.changes > 0
}

async function getPRHeadBaseSha(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ headSha: string; baseSha: string } | null> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = await getOwnerRepo(
    repoPath,
    connectionId,
    ...localGitOptionArgs(localGitOptions)
  )
  try {
    if (ownerRepo) {
      const { stdout } = await ghExecFileAsync(
        ['api', '--cache', '60s', `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}`],
        ghOptions
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
      ghOptions
    )
    const data = JSON.parse(stdout) as {
      headRefOid?: string
      baseRefOid?: string
    }
    if (data.headRefOid && data.baseRefOid) {
      return { headSha: data.headRefOid, baseSha: data.baseRefOid }
    }
    return null
  } catch {
    return null
  }
}

// Why: null = failed/blocked fetch (Files tab shows retry, not "No files changed."); [] = genuinely empty PR.
async function getPRFiles(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubPRFile[] | null> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = await getOwnerRepo(
    repoPath,
    connectionId,
    ...localGitOptionArgs(localGitOptions)
  )
  if (!ownerRepo) {
    return null
  }
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--cache',
        '60s',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}/files?per_page=100`
      ],
      ghOptions
    )
    const data = JSON.parse(stdout) as RESTPRFile[]
    return data.slice(0, MAX_PR_FILES).map((file) => ({
      path: file.filename,
      oldPath: file.previous_filename,
      status: mapFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
      isBinary: isBinaryHint(file),
      reviewCommentLineNumbers: getPRReviewCommentLineNumbersFromPatch(file.patch)
    }))
  } catch {
    return null
  }
}

type PRFileViewedStatesResult = {
  pullRequestId: string
  viewedStates: Map<string, GitHubPRFileViewedState>
}

async function getPRFileViewedStates(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRFileViewedStatesResult | null> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = await getOwnerRepo(
    repoPath,
    connectionId,
    ...localGitOptionArgs(localGitOptions)
  )
  if (!ownerRepo) {
    return null
  }
  if (rateLimitGuard('graphql').blocked) {
    return null
  }
  const viewedStates = new Map<string, GitHubPRFileViewedState>()
  let pullRequestId: string | null = null
  let after: string | null = null

  try {
    for (let fetched = 0; fetched < MAX_PR_FILES; fetched += 100) {
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${PR_FILE_VIEWED_STATES_QUERY}`,
        '-f',
        `owner=${ownerRepo.owner}`,
        '-f',
        `repo=${ownerRepo.repo}`,
        '-F',
        `number=${prNumber}`
      ]
      if (after) {
        args.push('-f', `after=${after}`)
      }
      noteRateLimitSpend('graphql')
      const { stdout } = await ghExecFileAsync(args, ghOptions)
      const parsed = JSON.parse(stdout) as {
        data?: {
          repository?: {
            pullRequest?: {
              id?: string
              files?: {
                pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
                nodes?: {
                  path?: string | null
                  viewerViewedState?: GitHubPRFileViewedState | null
                }[]
              }
            } | null
          } | null
        }
        errors?: { message?: string }[]
      }
      if (parsed.errors && parsed.errors.length > 0) {
        return null
      }
      const pullRequest = parsed.data?.repository?.pullRequest
      if (!pullRequest?.id) {
        return null
      }
      pullRequestId = pullRequest.id
      for (const file of pullRequest.files?.nodes ?? []) {
        if (file.path && file.viewerViewedState) {
          viewedStates.set(file.path, file.viewerViewedState)
        }
      }
      if (!pullRequest.files?.pageInfo?.hasNextPage || !pullRequest.files.pageInfo.endCursor) {
        break
      }
      after = pullRequest.files.pageInfo.endCursor
    }
  } catch {
    return null
  }

  return pullRequestId ? { pullRequestId, viewedStates } : null
}

function mergePRFileViewedStates(
  files: GitHubPRFile[],
  viewedStates: PRFileViewedStatesResult | null
): GitHubPRFile[] {
  if (!viewedStates) {
    return files
  }
  return files.map((file) => ({
    ...file,
    viewerViewedState: viewedStates.viewedStates.get(file.path) ?? 'UNVIEWED'
  }))
}

async function getIssueBodyAndComments(
  repoPath: string,
  issueNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{
  body: string
  comments: PRComment[]
  assignees: string[]
  timelineItems: GitHubIssueTimelineItem[]
}> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = await getIssueOwnerRepo(
    repoPath,
    connectionId,
    ...localGitOptionArgs(localGitOptions)
  )
  try {
    if (ownerRepo) {
      const [issueResult, commentsResult, timelineItems] = await Promise.all([
        ghExecFileAsync(
          [
            'api',
            '--cache',
            '60s',
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}`
          ],
          ghOptions
        ),
        ghExecFileAsync(
          [
            'api',
            '--cache',
            '60s',
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}/comments?per_page=100`
          ],
          ghOptions
        ),
        getIssueTimelineItems(ownerRepo, issueNumber, ghOptions)
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
      return { body: issue.body ?? '', comments, assignees, timelineItems }
    }
    // Fallback: non-GitHub remote
    const { stdout } = await ghExecFileAsync(
      ['issue', 'view', String(issueNumber), '--json', 'body,comments,assignees'],
      ghOptions
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
    return { body: data.body ?? '', comments, assignees: fallbackAssignees, timelineItems: [] }
  } catch {
    return { body: '', comments: [], assignees: [], timelineItems: [] }
  }
}

async function getPRBody(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = await getOwnerRepo(
    repoPath,
    connectionId,
    ...localGitOptionArgs(localGitOptions)
  )
  try {
    if (ownerRepo) {
      const { stdout } = await ghExecFileAsync(
        ['api', '--cache', '60s', `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}`],
        ghOptions
      )
      const data = JSON.parse(stdout) as { body?: string | null }
      return data.body ?? ''
    }
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', String(prNumber), '--json', 'body'],
      ghOptions
    )
    const data = JSON.parse(stdout) as { body?: string }
    return data.body ?? ''
  } catch {
    return ''
  }
}

async function getWorkItemParticipants(
  repoPath: string,
  item: Pick<GitHubWorkItem, 'number' | 'type'>,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubAssignableUser[]> {
  // Why: fork work items live upstream, so resolve owner/repo with the same upstream-first resolvers as body/comments (#7331).
  const ownerRepo =
    item.type === 'issue'
      ? await getIssueOwnerRepo(repoPath, connectionId, ...localGitOptionArgs(localGitOptions))
      : await getOwnerRepo(repoPath, connectionId, ...localGitOptionArgs(localGitOptions))
  if (!ownerRepo) {
    return []
  }
  if (rateLimitGuard('graphql').blocked) {
    return []
  }
  try {
    noteRateLimitSpend('graphql')
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
      ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
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
  logins: string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubAssignableUser[]> {
  const uniqueLogins = Array.from(
    new Set(logins.filter((login) => login && login !== 'ghost').map((login) => login.trim()))
  ).slice(0, 40)
  if (uniqueLogins.length === 0) {
    return []
  }
  if (rateLimitGuard('graphql').blocked) {
    // Why: log the skip — callers degrade silently to blank GHE avatars, so it's otherwise untraceable.
    console.warn(
      `getGitHubUsersByLogin skipped: GraphQL rate-limit budget exhausted (${uniqueLogins.length} logins unresolved)`
    )
    return []
  }
  const fields = uniqueLogins
    .map(
      (login, index) =>
        `u${index}: user(login: ${JSON.stringify(login)}) { login name avatarUrl(size: 48) }`
    )
    .join('\n')
  try {
    noteRateLimitSpend('graphql')
    const { stdout } = await ghExecFileAsync(
      ['api', 'graphql', '-f', `query=query { ${fields} }`],
      ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
    )
    const data = JSON.parse(stdout) as {
      data?: Record<
        string,
        {
          login?: string
          name?: string | null
          avatarUrl?: string | null
        } | null
      >
    }
    return Object.values(data.data ?? {})
      .filter(
        (
          user
        ): user is {
          login: string
          name?: string | null
          avatarUrl?: string | null
        } => Boolean(user?.login)
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

/**
 * Stamp GraphQL-resolved avatars onto a work item's author, reviewers, review requests, latest reviews, and assignees.
 *
 * Why: `gh pr view` omits avatar_url, so login-based avatars 404 on GHE; knownUsers carries the GraphQL-resolved ones. See #8784.
 */
function enrichItemDisplayAvatars(
  item: Omit<GitHubWorkItem, 'repoId'>,
  knownUsers: GitHubAssignableUser[]
): Omit<GitHubWorkItem, 'repoId'> {
  const avatarByLogin = new Map<string, string>()
  for (const user of knownUsers) {
    if (user.login && user.avatarUrl) {
      avatarByLogin.set(user.login.toLowerCase(), user.avatarUrl)
    }
  }
  if (avatarByLogin.size === 0) {
    return item
  }
  // Why: prefer the GraphQL-resolved avatar — `gh pr view` returns empty/`u/0` placeholders for enterprise users; fall back to the original only when the lookup is empty.
  const avatarFor = (login: string): string | undefined => avatarByLogin.get(login.toLowerCase())
  const resolvedAvatar = (login: string, existing?: string | null): string | undefined =>
    avatarFor(login) || existing || undefined
  // Callers coalesce a missing result to each field's "no avatar" sentinel ('' or null); GitHubUserAvatar falls back to login URL then initials.
  const authorAvatarUrl = (item.author ? avatarFor(item.author) : undefined) || item.authorAvatarUrl
  return {
    ...item,
    ...(authorAvatarUrl ? { authorAvatarUrl } : {}),
    ...(item.reviewRequests
      ? {
          reviewRequests: item.reviewRequests.map((user) => ({
            ...user,
            avatarUrl: resolvedAvatar(user.login, user.avatarUrl) ?? ''
          }))
        }
      : {}),
    ...(item.latestReviews
      ? {
          latestReviews: item.latestReviews.map((review) => ({
            ...review,
            avatarUrl: resolvedAvatar(review.login, review.avatarUrl) ?? null
          }))
        }
      : {}),
    ...(item.assignees
      ? {
          assignees: item.assignees.map((user) => ({
            ...user,
            avatarUrl: resolvedAvatar(user.login, user.avatarUrl) ?? ''
          }))
        }
      : {})
  }
}

async function getMentionParticipants(
  repoPath: string,
  item: Pick<
    GitHubWorkItem,
    'author' | 'number' | 'type' | 'reviewRequests' | 'latestReviews' | 'assignees'
  >,
  comments: PRComment[],
  participants: GitHubAssignableUser[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubAssignableUser[]> {
  // Why: resolve mention authors + display users (reviewers/assignees) in one aliased trip so avatars reuse it without a second rate-limited lookup (#8784).
  // Why: order display users before comment authors so the 40-login cap in getGitHubUsersByLogin can't drop a reviewer/assignee avatar.
  const visibleLogins = [
    item.author ?? '',
    ...(item.reviewRequests ?? []).map((user) => user.login),
    ...(item.latestReviews ?? []).map((review) => review.login),
    ...(item.assignees ?? []).map((user) => user.login),
    ...comments.map((comment) => comment.author)
  ]
  const graphQlUsers = await getGitHubUsersByLogin(
    repoPath,
    visibleLogins,
    connectionId,
    localGitOptions
  )
  return mergeGitHubUsers([...participants, ...graphQlUsers])
}

async function getPRChecksForDetails(
  repoPath: string,
  prNumber: number,
  headSha: string | undefined,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRCheckDetail[]> {
  try {
    return await getPRChecks(
      repoPath,
      prNumber,
      headSha,
      null,
      undefined,
      connectionId,
      ...localGitOptionArgs(localGitOptions)
    )
  } catch (err) {
    // Why: checks are auxiliary — a gh failure must not block opening the PR drawer.
    console.warn('getWorkItemDetails PR checks failed:', err)
    return []
  }
}

export async function getWorkItemDetails(
  repoPath: string,
  number: number,
  type?: 'issue' | 'pr',
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubWorkItemDetails | null> {
  // Why: getWorkItem self-manages acquire/release; call it outside our semaphore so the cheap lookup doesn't block detail fetches.
  const item: Omit<GitHubWorkItem, 'repoId'> | null = await getWorkItem(
    repoPath,
    number,
    type,
    connectionId,
    ...localGitOptionArgs(localGitOptions)
  )
  if (!item) {
    return null
  }

  await acquire()
  try {
    if (item.type === 'issue') {
      // Why: one GraphQL round-trip returns everything (its participants include commenters, so getMentionParticipants is skipped); fall back to REST+GraphQL on any failure.
      const collapsed = await getIssueDetailsViaGraphQL(
        repoPath,
        item.number,
        connectionId,
        localGitOptions
      )
      if (collapsed) {
        return {
          // Include assigneeUsers: non-participating assignees are absent from participants and keep a blank avatar (GHE).
          item: enrichItemDisplayAvatars(item, [
            ...collapsed.participants,
            ...collapsed.assigneeUsers
          ]),
          body: collapsed.body,
          comments: collapsed.comments,
          assignees: collapsed.assignees,
          participants: collapsed.participants,
          timelineItems: collapsed.timelineItems
        }
      }
      // Fallback: fetch body/comments and participants in parallel.
      const [{ body, comments, assignees, timelineItems }, participants] = await Promise.all([
        getIssueBodyAndComments(repoPath, item.number, connectionId, localGitOptions),
        getWorkItemParticipants(repoPath, item, connectionId, localGitOptions)
      ])
      const mentionParticipants = await getMentionParticipants(
        repoPath,
        item,
        comments,
        participants,
        connectionId,
        localGitOptions
      )
      return {
        item: enrichItemDisplayAvatars(item, mentionParticipants),
        body,
        comments,
        assignees,
        participants: mentionParticipants,
        timelineItems
      }
    }

    // PR: fetch body + comments + checks + files + head/base SHAs in parallel.
    const [body, comments, shas, files, viewedStates, participants] = await Promise.all([
      getPRBody(repoPath, item.number, connectionId, localGitOptions),
      getPRComments(
        repoPath,
        item.number,
        undefined,
        connectionId,
        ...localGitOptionArgs(localGitOptions)
      ),
      getPRHeadBaseSha(repoPath, item.number, connectionId, localGitOptions),
      getPRFiles(repoPath, item.number, connectionId, localGitOptions),
      getPRFileViewedStates(repoPath, item.number, connectionId, localGitOptions),
      getWorkItemParticipants(repoPath, item, connectionId, localGitOptions)
    ])

    // Why: mention-author lookup and checks are independent, so run them in parallel.
    const [mentionParticipants, checks] = await Promise.all([
      getMentionParticipants(repoPath, item, comments, participants, connectionId, localGitOptions),
      getPRChecksForDetails(repoPath, item.number, shas?.headSha, connectionId, localGitOptions)
    ])

    return {
      item: enrichItemDisplayAvatars(item, mentionParticipants),
      body,
      comments,
      headSha: shas?.headSha,
      baseSha: shas?.baseSha,
      pullRequestId: viewedStates?.pullRequestId,
      checks,
      // Why: null (failed fetch) vs empty PR — Files tab shows retry, not "No files changed."
      files: files === null ? undefined : mergePRFileViewedStates(files, viewedStates),
      filesUnavailable: files === null,
      participants: mentionParticipants
    }
  } finally {
    release()
  }
}

// Why: Monaco DiffViewer needs original/modified text (not patches); --cache bounds rate-limit spend on rapid file-expands.
async function fetchContentAtRef(args: {
  repoPath: string
  connectionId?: string | null
  localGitOptions?: LocalGitExecOptions
  owner: string
  repo: string
  path: string
  ref: string
}): Promise<{ content: string; isBinary: boolean; tooLarge?: boolean }> {
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
      {
        ...ghRepoExecOptions(
          githubRepoContext(args.repoPath, args.connectionId, args.localGitOptions)
        ),
        maxBuffer: GITHUB_RAW_CONTENT_MAX_BUFFER_BYTES
      }
    )
    // Heuristic: a NUL byte in the first 2KB means binary (execFile decodes as lossy utf-8).
    const sample = stdout.slice(0, 2048)
    if (sample.includes('\u0000')) {
      return { content: '', isBinary: true }
    }
    return { content: stdout, isBinary: false }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return { content: '', isBinary: false, tooLarge: true }
    }
    return { content: '', isBinary: false }
  }
}

export async function getPRFileContents(args: {
  repoPath: string
  connectionId?: string | null
  localGitOptions?: LocalGitExecOptions
  prNumber: number
  path: string
  oldPath?: string
  status: GitHubPRFile['status']
  headSha: string
  baseSha: string
}): Promise<GitHubPRFileContents> {
  const ownerRepo = await getOwnerRepo(
    args.repoPath,
    args.connectionId,
    ...localGitOptionArgs(args.localGitOptions)
  )
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
    // Why: added files have no base-ref original, removed files no head-ref modified; skip those to avoid spurious 404s.
    const needsOriginal = args.status !== 'added'
    const needsModified = args.status !== 'removed'
    const originalRef = args.baseSha
    const originalPath = args.oldPath ?? args.path

    const [original, modified] = await Promise.all([
      needsOriginal
        ? fetchContentAtRef({
            repoPath: args.repoPath,
            connectionId: args.connectionId,
            localGitOptions: args.localGitOptions,
            owner: ownerRepo.owner,
            repo: ownerRepo.repo,
            path: originalPath,
            ref: originalRef
          })
        : Promise.resolve<{ content: string; isBinary: boolean; tooLarge?: boolean }>({
            content: '',
            isBinary: false
          }),
      needsModified
        ? fetchContentAtRef({
            repoPath: args.repoPath,
            connectionId: args.connectionId,
            localGitOptions: args.localGitOptions,
            owner: ownerRepo.owner,
            repo: ownerRepo.repo,
            path: args.path,
            ref: args.headSha
          })
        : Promise.resolve<{ content: string; isBinary: boolean; tooLarge?: boolean }>({
            content: '',
            isBinary: false
          })
    ])

    return {
      original: original.content,
      modified: modified.content,
      originalIsBinary: original.isBinary,
      modifiedIsBinary: modified.isBinary,
      originalTooLarge: original.tooLarge,
      modifiedTooLarge: modified.tooLarge
    }
  } finally {
    release()
  }
}
