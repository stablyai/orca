/* eslint-disable max-lines -- Why: the PR/Issue details service groups the
   body/comments/files/checks fetch paths alongside the file-contents resolver
   so the drawer's rate-limit and caching strategy lives in one place. */
import type {
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubWorkItem,
  GitHubWorkItemDetails,
  PRCheckDetail,
  PRComment
} from '../../shared/types'
import { ghExecFileAsync, acquire, release, getOwnerRepo } from './gh-utils'
import { getWorkItem, getPRChecks, getPRComments } from './client'

// Why: a PR "changed file" listing returned by the REST endpoint is paginated
// at 100 per page; we cap at a reasonable total so a massive PR cannot starve
// the gh semaphore while we fetch file listings.
const MAX_PR_FILES = 300

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
): Promise<{ body: string; comments: PRComment[] }> {
  const ownerRepo = await getOwnerRepo(repoPath)
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
      const issue = JSON.parse(issueResult.stdout) as { body?: string | null }
      type RESTComment = {
        id: number
        user: { login: string; avatar_url: string } | null
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
          url: c.html_url
        })
      )
      return { body: issue.body ?? '', comments }
    }
    // Fallback: non-GitHub remote
    const { stdout } = await ghExecFileAsync(
      ['issue', 'view', String(issueNumber), '--json', 'body,comments'],
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
    return { body: data.body ?? '', comments }
  } catch {
    return { body: '', comments: [] }
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

export async function getWorkItemDetails(
  repoPath: string,
  number: number
): Promise<GitHubWorkItemDetails | null> {
  // Why: getWorkItem already handles acquire/release. We call it first (outside
  // our semaphore) so the known-cheap lookup doesn't compete with the richer
  // detail fetches that follow.
  const item: GitHubWorkItem | null = await getWorkItem(repoPath, number)
  if (!item) {
    return null
  }

  await acquire()
  try {
    if (item.type === 'issue') {
      const { body, comments } = await getIssueBodyAndComments(repoPath, item.number)
      return { item, body, comments }
    }

    // PR: fetch body + comments + checks + files + head/base SHAs in parallel.
    const [body, comments, shas, files] = await Promise.all([
      getPRBody(repoPath, item.number),
      getPRComments(repoPath, item.number),
      getPRHeadBaseSha(repoPath, item.number),
      getPRFiles(repoPath, item.number)
    ])

    const checks: PRCheckDetail[] = shas?.headSha
      ? await getPRChecks(repoPath, item.number, shas.headSha)
      : await getPRChecks(repoPath, item.number)

    return {
      item,
      body,
      comments,
      headSha: shas?.headSha,
      baseSha: shas?.baseSha,
      checks,
      files
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
