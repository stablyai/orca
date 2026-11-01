import type { IssueSourcePreference } from '../../shared/repo-types'
import { extractExecError } from '../git/exec-error'
import { teaExecFileAsync } from '../git/runner'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { resolveGiteaIssueSource } from './gitea-issue-source-resolution'
import { configuredGiteaApiBaseUrl } from './gitea-json-request'
import { acquire, release } from './tea-admission'
import { teaRepoArgs, type GiteaRepoRef, type LocalGitExecOptions } from './repository-ref'

export type GiteaMutationFailure = { ok: false; error: string }

export type GiteaMutationResult = { ok: true } | GiteaMutationFailure

export type GiteaProjectRef = { host: string; path: string }

const WRITE_TIMEOUT_MS = 30_000

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function directGiteaApiToken(): string | null {
  return envValue('ORCA_GITEA_TOKEN') ?? envValue('GITEA_TOKEN')
}

export function giteaWriteUsesTea(repo: GiteaRepoRef): boolean {
  return directGiteaApiToken() === null && Boolean(repo.loginName)
}

export function giteaPullIndexArg(index: number): string | null {
  if (!Number.isInteger(index) || index <= 0) {
    return null
  }
  return String(index)
}

export function giteaMutationErrorText(error: unknown): string {
  const extracted = extractExecError(error)
  const message = error instanceof Error ? error.message : ''
  const text = [extracted.stderr, extracted.stdout, message]
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .trim()
  return text || 'Gitea request failed.'
}

export const GITEA_AUTH_REQUIRED_ERROR =
  'Gitea is not authenticated. Set ORCA_GITEA_TOKEN or run tea login add.'

export function giteaAuthRequiredResult(): GiteaMutationFailure {
  return { ok: false, error: GITEA_AUTH_REQUIRED_ERROR }
}

function repoFromProjectRef(projectRef: GiteaProjectRef): GiteaRepoRef | null {
  const segments = projectRef.path.split('/').filter(Boolean)
  const owner = segments[0]
  const repo = segments[1]
  if (!owner || !repo || segments.length !== 2) {
    return null
  }
  const webBaseUrl = /^https?:\/\//i.test(projectRef.host)
    ? projectRef.host.replace(/\/+$/, '')
    : `https://${projectRef.host}`
  let host = projectRef.host
  try {
    host = new URL(webBaseUrl).hostname
  } catch {
    host = projectRef.host
  }
  return {
    host,
    owner,
    repo,
    apiBaseUrl: `${webBaseUrl}/api/v1`,
    webBaseUrl
  }
}

export async function resolveGiteaMutationRepo(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaRepoRef | null> {
  const { source } = await resolveGiteaIssueSource(
    repoPath,
    preference,
    connectionId,
    localGitOptions
  )
  if (!projectRef) {
    return source
  }
  const override = repoFromProjectRef(projectRef)
  if (!override) {
    return source
  }
  return source?.loginName ? { ...override, loginName: source.loginName } : override
}

export function teaPullCommand(repo: GiteaRepoRef, argsAfterPull: string[]): string[] | null {
  if (!repo.loginName) {
    return null
  }
  return ['pr', ...argsAfterPull, ...teaRepoArgs(repo)]
}

export async function runGiteaTeaCommand(
  args: string[],
  localGitOptions: LocalGitExecOptions = {},
  cwd?: string,
  timeoutMs = WRITE_TIMEOUT_MS
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  await acquire()
  try {
    // A completed write can still surface as a timeout, so tea must not retry it.
    const { stdout } = await teaExecFileAsync(args, {
      ...(cwd ? { cwd } : {}),
      timeout: timeoutMs,
      idempotent: false,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
      ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
    })
    return { ok: true, stdout }
  } catch (error) {
    return { ok: false, error: giteaMutationErrorText(error) }
  } finally {
    release()
  }
}

export async function writeGiteaJson(
  repo: GiteaRepoRef,
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: Record<string, unknown>
): Promise<GiteaMutationResult> {
  const token = directGiteaApiToken()
  try {
    const response = await fetch(new URL(`${configuredGiteaApiBaseUrl(repo)}${path}`), {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `token ${token}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS)
    })
    if (response.ok) {
      await cancelUnreadResponseBody(response)
      return { ok: true }
    }
    const text = (await response.text()).trim()
    return { ok: false, error: text || `Gitea request failed: HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, error: giteaMutationErrorText(error) }
  }
}

export function encodedGiteaRepoPath(repo: GiteaRepoRef): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
}
