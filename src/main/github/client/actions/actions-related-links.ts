import type { ActionsDetailMetadata, ActionsRun } from '../../../../shared/github/actions-types'
import type { GitHubApiRepository } from '../../github-api-repository'
import type { GhExecOptions } from '../github-exec-scope'
import { actionsUrl } from '../../../../shared/github/actions-web-url'
import { actionsJson } from './actions-read-request'
import { actionsRecord } from './workflow-run-field-mapping'

export async function readActionsRelatedLinks(
  raw: Record<string, unknown>,
  run: ActionsRun,
  repository: GitHubApiRepository,
  options: GhExecOptions
): Promise<Pick<ActionsDetailMetadata, 'commitUrl' | 'pullRequests' | 'relatedLinksUnavailable'>> {
  const base = `repos/${repository.owner}/${repository.repo}`
  let unavailable = false
  const read = async (endpoint: string): Promise<Record<string, unknown> | null> => {
    try {
      return actionsRecord(await actionsJson(endpoint, options))
    } catch {
      unavailable = true
      return null
    }
  }
  const commit = async (): Promise<string | null> => {
    if (!run.headSha || !/^[0-9a-f]{40}$/i.test(run.headSha)) {
      return null
    }
    const result = await read(`${base}/commits/${run.headSha}`)
    if (!result) {
      return null
    }
    if (result.sha !== run.headSha || !actionsUrl(result.html_url)) {
      unavailable = true
      return null
    }
    return actionsUrl(result.html_url)
  }
  const candidates = Array.isArray(raw.pull_requests) ? raw.pull_requests : []
  const seen = new Set<number>()
  const pulls = candidates
    .filter(
      (value): value is Record<string, unknown> =>
        !!value && typeof value === 'object' && !Array.isArray(value)
    )
    .filter((value) => {
      const number = value.number
      if (
        typeof number !== 'number' ||
        !Number.isSafeInteger(number) ||
        number <= 0 ||
        seen.has(number)
      ) {
        return false
      }
      seen.add(number)
      return true
    })
  if (pulls.length > 5) {
    unavailable = true
  }
  const [commitUrl, links] = await Promise.all([
    commit(),
    Promise.all(
      pulls.slice(0, 5).map(async (pull) => {
        const number = Number(pull.number)
        const explicit = actionsUrl(pull.html_url)
        if (explicit) {
          return { number, url: explicit }
        }
        // A run may name PRs from another repository; never reinterpret their numbers locally.
        const apiUrl = actionsUrl(pull.url)
        if (!apiUrl) {
          return null
        }
        const url = new URL(apiUrl)
        const host = repository.host?.toLowerCase() ?? 'github.com'
        const apiHost = host === 'github.com' ? 'api.github.com' : host
        const path = `/${base}/pulls/${number}`.toLowerCase()
        if (
          url.host.toLowerCase() !== apiHost ||
          ![path, `/api/v3${path}`].includes(url.pathname.toLowerCase())
        ) {
          return null
        }
        const result = await read(`${base}/pulls/${number}`)
        const htmlUrl = result?.number === number ? actionsUrl(result.html_url) : null
        if (!htmlUrl) {
          unavailable = true
          return null
        }
        return { number, url: htmlUrl }
      })
    )
  ])
  options.signal?.throwIfAborted()
  return {
    commitUrl,
    pullRequests: links.filter((link) => link !== null),
    relatedLinksUnavailable: unavailable
  }
}
