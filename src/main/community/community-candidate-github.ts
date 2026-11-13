import { getMainHttpClient } from '../network/http-client'
import { resolveGhAccountToken } from '../github/accounts/gh-account-token'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
export async function fetchCommunityCandidateJson(
  getUser: () => Promise<string | null>,
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const user = await getUser()
  if (!user) {
    throw new Error('Choose a GitHub account in Community before preparing a build.')
  }
  const token = await resolveGhAccountToken({ host: 'github.com', user })
  const response = await getMainHttpClient().fetch(`https://api.github.com/${path}`, {
    ...init,
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    }
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`GitHub candidate request failed (HTTP ${response.status}).`)
  }
  if (response.status === 204) {
    await response.body?.cancel()
    return null
  }
  return readFetchResponseJsonWithinLimit(response, 4 * 1024 * 1024)
}
