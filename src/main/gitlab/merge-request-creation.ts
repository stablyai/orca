import { readFile } from 'fs/promises'
import { join } from 'path'
import type { CreateHostedReviewInput, CreateHostedReviewResult } from '../../shared/hosted-review'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/hosted-review-refs'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'
import { getProjectSlug } from './client'
import {
  acquire,
  glabExecFileAsync,
  glabHostnameArgs,
  glabRepoExecOptions,
  release,
  type ProjectRef
} from './gl-utils'

function execErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const maybeExec = error as Error & { stderr?: unknown; stdout?: unknown }
    return [maybeExec.stderr, maybeExec.stdout, error.message]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .trim()
  }
  return String(error)
}

function classifyCreateMRError(error: unknown): CreateHostedReviewResult {
  const message = execErrorMessage(error)
  if (message) {
    console.warn('createGitLabMergeRequest failed:', message)
  }
  const lower = message.toLowerCase()
  if (
    lower.includes('not logged') ||
    lower.includes('not authenticated') ||
    lower.includes('authentication') ||
    lower.includes('glab auth login') ||
    lower.includes('http 401')
  ) {
    return {
      ok: false,
      code: 'auth_required',
      error:
        'Create MR failed: GitLab is not authenticated. Next step: run glab auth login in this environment.'
    }
  }
  if (lower.includes('already exists') || lower.includes('merge request already exists')) {
    return {
      ok: false,
      code: 'already_exists',
      error: 'A merge request already exists for this branch.'
    }
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return {
      ok: false,
      code: 'unknown_completion',
      error: 'MR creation may have completed. Refreshing branch review state...'
    }
  }
  if (lower.includes('validation failed') || lower.includes('http 422')) {
    return {
      ok: false,
      code: 'validation',
      error:
        'Create MR failed: GitLab rejected the merge request. Check the base branch and branch state, then try again.'
    }
  }
  return {
    ok: false,
    code: 'unknown',
    error: 'Create MR failed: GitLab could not create the merge request. Try again in a moment.'
  }
}

function parseMergeRequestPayload(stdout: string): { number: number; url: string } | null {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      iid?: unknown
      number?: unknown
      web_url?: unknown
      webUrl?: unknown
      url?: unknown
    }
    const number = Number(parsed.iid ?? parsed.number)
    const url =
      typeof parsed.web_url === 'string'
        ? parsed.web_url.trim()
        : typeof parsed.webUrl === 'string'
          ? parsed.webUrl.trim()
          : typeof parsed.url === 'string'
            ? parsed.url.trim()
            : ''
    if (Number.isInteger(number) && number > 0 && url) {
      return { number, url }
    }
  } catch {
    // Fall through to URL parsing for glab's normal text output.
  }
  const urlMatch = trimmed.match(/https?:\/\/[^\s]+\/-\/merge_requests\/(\d+)/)
  if (!urlMatch) {
    return null
  }
  return { number: Number(urlMatch[1]), url: urlMatch[0] }
}

async function findOpenMRByHeadBase(args: {
  repoPath: string
  projectRef: ProjectRef
  head: string
  base: string
  connectionId?: string | null
}): Promise<{ number: number; url: string } | null> {
  const { stdout } = await glabExecFileAsync(
    [
      'mr',
      'list',
      '-R',
      args.projectRef.path,
      '--source-branch',
      args.head,
      '--target-branch',
      args.base,
      '--per-page',
      '2',
      '--output',
      'json',
      ...glabHostnameArgs(args.projectRef, args.connectionId)
    ],
    glabRepoExecOptions(args.repoPath, args.connectionId)
  )
  const list = JSON.parse(stdout) as {
    iid?: number
    number?: number
    web_url?: string
    webUrl?: string
    url?: string
  }[]
  if (list.length !== 1) {
    return null
  }
  return parseMergeRequestPayload(JSON.stringify(list[0]))
}

async function readMergeRequestTemplate(
  repoPath: string,
  connectionId?: string | null
): Promise<string> {
  const relativeCandidates = [
    '.gitlab/merge_request_templates/Default.md',
    '.gitlab/merge_request_templates/default.md',
    '.gitlab/merge_request_template.md',
    '.gitlab/MERGE_REQUEST_TEMPLATE.md'
  ]
  const remoteProvider = connectionId ? getSshFilesystemProvider(connectionId) : undefined
  if (connectionId && !remoteProvider) {
    return ''
  }
  for (const relativeCandidate of relativeCandidates) {
    try {
      if (remoteProvider) {
        const result = await remoteProvider.readFile(
          joinWorktreeRelativePath(repoPath, relativeCandidate)
        )
        if (result.isBinary) {
          continue
        }
        return result.content
      }
      return await readFile(join(repoPath, relativeCandidate), 'utf8')
    } catch {
      // Try the next conventional GitLab merge-request template path.
    }
  }
  return ''
}

export async function createGitLabMergeRequest(
  repoPath: string,
  input: CreateHostedReviewInput,
  connectionId?: string | null
): Promise<CreateHostedReviewResult> {
  if (input.provider !== 'gitlab') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.'
    }
  }

  const projectRef = await getProjectSlug(repoPath, connectionId)
  if (!projectRef) {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating merge requests requires a GitLab remote.'
    }
  }

  const base = normalizeHostedReviewBaseRef(input.base)
  const head = input.head ? normalizeHostedReviewHeadRef(input.head) || undefined : undefined
  const title = input.title.trim()
  if (!base || !title) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create MR failed: base branch and title are required.'
    }
  }
  if (head && head.toLowerCase() === base.toLowerCase()) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create MR failed: choose a different base branch before creating a merge request.'
    }
  }

  await acquire()
  try {
    const body =
      input.useTemplate && !input.body?.trim()
        ? await readMergeRequestTemplate(repoPath, connectionId)
        : (input.body ?? '')
    const createArgs = [
      'mr',
      'create',
      '-R',
      projectRef.path,
      '--target-branch',
      base,
      '--title',
      title,
      '--description',
      body,
      '--yes',
      ...glabHostnameArgs(projectRef, connectionId)
    ]
    if (head) {
      createArgs.push('--source-branch', head)
    }
    if (input.draft) {
      createArgs.push('--draft')
    }
    try {
      const { stdout } = await glabExecFileAsync(createArgs, {
        ...glabRepoExecOptions(repoPath, connectionId),
        timeout: 60_000,
        idempotent: false
      })
      const created = parseMergeRequestPayload(stdout)
      if (created) {
        return { ok: true, ...created }
      }
      const found = head
        ? await findOpenMRByHeadBase({ repoPath, projectRef, head, base, connectionId }).catch(
            () => null
          )
        : null
      if (found) {
        return { ok: true, ...found }
      }
      return {
        ok: false,
        code: 'unknown_completion',
        error: 'MR creation may have completed. Refreshing branch review state...'
      }
    } catch (error) {
      const classified = classifyCreateMRError(error)
      if (
        !classified.ok &&
        (classified.code === 'already_exists' || classified.code === 'unknown_completion') &&
        head
      ) {
        const existing = await findOpenMRByHeadBase({
          repoPath,
          projectRef,
          head,
          base,
          connectionId
        }).catch(() => null)
        if (existing) {
          return {
            ok: false,
            code: 'already_exists',
            error: 'A merge request already exists for this branch.',
            existingReview: existing
          }
        }
      }
      return classified
    }
  } finally {
    release()
  }
}
