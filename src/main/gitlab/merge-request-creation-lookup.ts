import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import {
  glabExecFileAsync,
  glabHostnameArgs,
  glabRepoExecOptions,
  type ProjectRef
} from './gl-utils'

export function parseMergeRequestPayload(stdout: string): { number: number; url: string } | null {
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

export async function findOpenMRByHeadBase(args: {
  repoPath: string
  projectRef: ProjectRef
  head: string
  base: string
  connectionId?: string | null
  options?: HostedReviewExecutionOptions
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
    {
      ...glabRepoExecOptions(args.repoPath, args.connectionId),
      ...(args.connectionId ? {} : getHostedReviewLocalGitOptions(args.options))
    }
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
