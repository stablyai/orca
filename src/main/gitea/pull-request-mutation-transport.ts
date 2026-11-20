import type { IssueSourcePreference } from '../../shared/repository/repo-types'
import { extractExecError } from '../git/command-runner/process-capture/exec-error'
import { gtExecFileAsync } from '../git/command-runner/gt-exec-file'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { resolveGiteaIssueSource } from './gitea-issue-source-resolution'
import { configuredGiteaApiBaseUrl } from './gitea-json-request'
import { acquire, release } from './gt-admission'
import { gtRepoArgs, type GiteaRepoRef, type LocalGitExecOptions } from './repository-ref'
import type {
  GiteaMutationFailure,
  GiteaMutationResult,
  GiteaProjectRef
} from '../../shared/gitea-types'

export type { GiteaMutationFailure, GiteaMutationResult, GiteaProjectRef }

const WRITE_TIMEOUT_MS = 30_000

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function directGiteaApiToken(): string | null {
  return envValue('ORCA_GITEA_TOKEN') ?? envValue('GITEA_TOKEN')
}

export function giteaWriteUsesGt(repo: GiteaRepoRef): boolean {
  return directGiteaApiToken() === null && Boolean(repo.loginName)
}

export function giteaPullIndexArg(index: number): string | null {
  if (!Number.isInteger(index) || index <= 0) {
    return null
  }
  return String(index)
}

function parseGtJsonError(text: string): string | null {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      if ('error' in parsed && parsed.error && typeof parsed.error === 'object') {
        const msg = (parsed.error as { message?: unknown }).message
        if (typeof msg === 'string' && msg.trim()) {
          return msg.trim()
        }
      }
      if ('message' in parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim()
      }
    }
  } catch {
    // not JSON
  }
  return null
}

export function giteaMutationErrorText(error: unknown): string {
  const extracted = extractExecError(error)
  const jsonMsg = parseGtJsonError(extracted.stderr)
  if (jsonMsg) {
    return jsonMsg
  }
  const message = error instanceof Error ? error.message : ''
  const text = [extracted.stderr, extracted.stdout, message]
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .trim()
  return text || 'Gitea request failed.'
}

export const GITEA_AUTH_REQUIRED_ERROR =
  'Gitea is not authenticated. Set ORCA_GITEA_TOKEN or run gt auth login.'

export function giteaAuthRequiredResult(): GiteaMutationFailure {
  return { ok: false, error: GITEA_AUTH_REQUIRED_ERROR }
}

export function encodedGiteaRepoPath(repo: GiteaRepoRef): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
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

export function gtPullCommand(repo: GiteaRepoRef, argsAfterPull: string[]): string[] | null {
  if (!repo.loginName) {
    return null
  }
  return ['pr', ...argsAfterPull, ...gtRepoArgs(repo)]
}

export async function runGiteaGtCommand(
  args: string[],
  localGitOptions: LocalGitExecOptions = {},
  cwd?: string,
  timeoutMs = WRITE_TIMEOUT_MS
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  await acquire()
  try {
    const { stdout } = await gtExecFileAsync(args, {
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
