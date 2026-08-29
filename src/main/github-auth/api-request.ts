import { getMainHttpClient } from '../network/http-client'
import { GITHUB_API_BASE_URL } from './github-auth-config'

export type GitHubApiResult<T> =
  | { ok: true; data: T }
  // 'rejected' = GitHub answered 401/403 (bad or under-scoped token);
  // 'unreachable' = network/5xx/parse failure — retrying the same token is fine.
  | { ok: false; reason: 'rejected' | 'unreachable'; status?: number; message: string }

export async function githubApiGet<T>(
  token: string,
  path: string,
  timeoutMs = 15000
): Promise<GitHubApiResult<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await getMainHttpClient().fetch(`${GITHUB_API_BASE_URL}${path}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: 'rejected',
        status: response.status,
        message: `${response.status}`
      }
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: 'unreachable',
        status: response.status,
        message: `${response.status}`
      }
    }
    return { ok: true, data: (await response.json()) as T }
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      message: error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
}
