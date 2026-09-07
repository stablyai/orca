import type { HostedReviewSummary } from '../../shared/hosted-review'

export type NumberedHostedReviewSummary = Omit<HostedReviewSummary, 'number'> & { number: number }

export type GitHubStackPullRequest = NumberedHostedReviewSummary & {
  headRefName: string
  baseRefName: string
}

export type GitHubStack = {
  number: number
  open: boolean
  pull_requests: { number: number }[]
}

export function parseGitHubStackPullRequests(stdout: string): GitHubStackPullRequest[] {
  const pullRequests = JSON.parse(stdout) as {
    number?: unknown
    html_url?: unknown
    head?: { ref?: unknown }
    base?: { ref?: unknown }
  }[]
  return pullRequests.flatMap((pullRequest) => {
    const number = Number(pullRequest.number)
    const url = typeof pullRequest.html_url === 'string' ? pullRequest.html_url : ''
    const headRefName = typeof pullRequest.head?.ref === 'string' ? pullRequest.head.ref : ''
    const baseRefName = typeof pullRequest.base?.ref === 'string' ? pullRequest.base.ref : ''
    return Number.isInteger(number) && number > 0 && url && headRefName && baseRefName
      ? [{ number, url, headRefName, baseRefName }]
      : []
  })
}

export function parseGitHubStacks(stdout: string): GitHubStack[] {
  const stacks = JSON.parse(stdout) as {
    number?: unknown
    open?: unknown
    pull_requests?: { number?: unknown }[]
  }[]
  return stacks.flatMap((stack) => {
    const number = Number(stack.number)
    const pullRequests = (stack.pull_requests ?? []).flatMap((pullRequest) => {
      const pullRequestNumber = Number(pullRequest.number)
      return Number.isInteger(pullRequestNumber) && pullRequestNumber > 0
        ? [{ number: pullRequestNumber }]
        : []
    })
    return Number.isInteger(number) && number > 0
      ? [{ number, open: stack.open === true, pull_requests: pullRequests }]
      : []
  })
}
