import type { MRComment } from '../../shared/gitlab-types'
import { configuredGiteaApiBaseUrl, requestGiteaJson } from './gitea-json-request'
import {
  directGiteaApiToken,
  encodedGiteaRepoPath,
  giteaMutationErrorText,
  runGiteaTeaCommand,
  type GiteaMutationFailure
} from './pull-request-mutation-transport'
import { teaRepoArgs, type GiteaRepoRef, type LocalGitExecOptions } from './repository-ref'

const WRITE_TIMEOUT_MS = 30_000

export type GiteaCommentResult = { ok: true; comment: MRComment } | GiteaMutationFailure

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

export function parseGiteaJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function commentAuthor(record: Record<string, unknown>): { login: string; avatarUrl: string } {
  const user = isRecord(record.user) ? record.user : null
  const login = user ? readString(user, 'login') || readString(user, 'username') : ''
  return {
    login: login || 'unknown',
    avatarUrl: user ? readString(user, 'avatar_url') : ''
  }
}

function mapCreatedComment(value: unknown, fallbackBody: string): MRComment | null {
  if (!isRecord(value)) {
    return null
  }
  const id = positiveInteger(value.id)
  if (id === null) {
    return null
  }
  const author = commentAuthor(value)
  const body = readString(value, 'body')
  return {
    id,
    author: author.login,
    authorAvatarUrl: author.avatarUrl,
    body: body || fallbackBody,
    createdAt: readString(value, 'created_at'),
    url: readString(value, 'html_url'),
    isBot: author.login.toLowerCase().endsWith('[bot]')
  }
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

export function mapGiteaInlineComment(
  record: Record<string, unknown>,
  fallback: { body: string; path: string; line: number | null }
): MRComment | null {
  const comment = mapCreatedComment(record, fallback.body)
  if (!comment) {
    return null
  }
  const path = readString(record, 'path') || fallback.path
  const line =
    positiveInteger(record.position) ?? positiveInteger(record.new_position) ?? fallback.line
  return {
    ...comment,
    threadId: String(comment.id),
    isResolved: Boolean(record.resolver),
    ...(path ? { path } : {}),
    ...(line !== null ? { line } : {})
  }
}

function pickInlineComment(
  value: unknown,
  fallback: { body: string; path: string; line: number | null }
): MRComment | null {
  const list = Array.isArray(value)
    ? records(value)
    : isRecord(value)
      ? records(value.comments)
      : []
  const mapped = list.flatMap((record) => {
    const comment = mapGiteaInlineComment(record, fallback)
    return comment ? [comment] : []
  })
  const matched = mapped.filter((comment) => comment.body === fallback.body)
  return matched.at(-1) ?? mapped.at(-1) ?? null
}

export function giteaCommentResult(data: unknown, fallbackBody: string): GiteaCommentResult {
  const comment = mapCreatedComment(data, fallbackBody)
  return comment
    ? { ok: true, comment }
    : { ok: false, error: 'Gitea did not return the created comment.' }
}

export function mapGiteaReplyUrl(stdout: string, body: string): MRComment | null {
  const url = stdout.trim()
  const match = /issuecomment-(\d+)/.exec(url)
  const id = match ? Number.parseInt(match[1], 10) : Number.NaN
  if (!Number.isInteger(id) || id <= 0) {
    return null
  }
  return {
    id,
    author: 'unknown',
    authorAvatarUrl: '',
    body,
    createdAt: '',
    url,
    isBot: false,
    threadId: String(id),
    isResolved: false
  }
}

export async function postGiteaHttpJson(
  repo: GiteaRepoRef,
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: true; data: unknown } | GiteaMutationFailure> {
  const token = directGiteaApiToken()
  try {
    const response = await fetch(new URL(`${configuredGiteaApiBaseUrl(repo)}${path}`), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `token ${token}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS)
    })
    if (!response.ok) {
      const text = (await response.text()).trim()
      return { ok: false, error: text || `Gitea request failed: HTTP ${response.status}` }
    }
    const text = await response.text()
    return { ok: true, data: parseGiteaJson(text) }
  } catch (error) {
    return { ok: false, error: giteaMutationErrorText(error) }
  }
}

export async function postGiteaTeaJson(
  repo: GiteaRepoRef,
  path: string,
  body: Record<string, unknown>,
  localGitOptions: LocalGitExecOptions,
  repoPath: string
): Promise<{ ok: true; stdout: string } | GiteaMutationFailure> {
  return runGiteaTeaCommand(
    ['api', '-X', 'POST', path, '-d', JSON.stringify(body), ...teaRepoArgs(repo)],
    localGitOptions,
    repoPath
  )
}

export async function loadCreatedGiteaInlineComment(
  repo: GiteaRepoRef,
  indexArg: string,
  data: unknown,
  fallback: { body: string; path: string; line: number }
): Promise<GiteaCommentResult> {
  const direct = pickInlineComment(data, fallback)
  if (direct) {
    return { ok: true, comment: direct }
  }
  const reviewId = isRecord(data) ? positiveInteger(data.id) : null
  if (reviewId === null) {
    return { ok: false, error: 'Gitea did not return the created comment.' }
  }
  const listed = await requestGiteaJson(
    repo,
    `/repos/${encodedGiteaRepoPath(repo)}/pulls/${indexArg}/reviews/${reviewId}/comments`
  )
  const loaded = pickInlineComment(listed, fallback)
  return loaded
    ? { ok: true, comment: loaded }
    : { ok: false, error: 'Gitea did not return the created comment.' }
}

export function isGiteaJsonRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}
